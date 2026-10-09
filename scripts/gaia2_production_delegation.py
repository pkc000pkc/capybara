"""Trusted production-like parent delegation factory (GAIA2 5.2d2).

The official bridge only knows how to ask for a per-run coordinator.  This
adapter supplies the missing ownership boundary for a local production-like
configuration: it creates a fresh :class:`NativeAppBinding` and notification
origin registry for every official run, then builds a
``ParentA2ACoordinator`` whose child callback is supplied by trusted adapter
code.  It is intentionally not a provider, Scenario, or Node/A2A transport.

The callback is never obtained from Actor JSON, model output, environment
variables, or a pipe.  ``close`` revokes an active child through the
coordinator and closes the native owner even when the parent run stops or
fails.
"""

from __future__ import annotations

from typing import Any, Callable

from gaia2_notification_producer import ScopedNotificationOriginRegistry
from gaia2_parent_a2a_coordinator import ParentA2AError, ParentA2ACoordinator
from gaia2_private_native_binding import NativeAppBinding
from are.simulation.environment import Environment


class ProductionDelegationError(RuntimeError):
    """Fixed adapter error; callback exception details never cross the seam."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class ProductionDelegationHandle:
    """Per-official-run coordinator plus its trusted native owner."""

    def __init__(self, *, coordinator: ParentA2ACoordinator,
                 owner: NativeAppBinding, env: Environment):
        if (type(coordinator) is not ParentA2ACoordinator
                or type(owner) is not NativeAppBinding
                or type(env) is not Environment
                or coordinator.environment is not env
                or owner.clock_environment is not env):
            raise ProductionDelegationError("PRODUCTION_HANDLE_INVALID")
        self.__coordinator = coordinator
        self.__owner = owner
        self.__env = env
        self.__closed = False

    @property
    def environment(self) -> Environment:
        return self.__env

    @property
    def owner(self) -> NativeAppBinding:
        """Trusted inspection only; never part of Actor/pipe input."""
        return self.__owner

    def begin_child(self, *, action: dict, parent_gate: dict):
        return self.__coordinator.begin_child(action=action, parent_gate=parent_gate)

    def run_child(self, handle):
        return self.__coordinator.run_child(handle)

    def close(self, reason: str = "parent_close") -> None:
        """Close child authority first, then the owner, exactly once."""
        if self.__closed:
            return
        self.__closed = True
        error = None
        try:
            self.__coordinator.close(reason)
        except BaseException as exc:
            error = exc
        try:
            self.__owner.close()
        except BaseException as exc:
            error = error or exc
        if error is not None:
            raise ProductionDelegationError("PRODUCTION_CLOSE_FAILED") from None

    def snapshot(self) -> dict[str, Any]:
        return {
            "schemaVersion": "gaia2-production-delegation-handle-v1",
            "closed": self.__closed,
            "coordinator": self.__coordinator.snapshot(),
            "ownerManifestHash": self.__owner.manifest().get("toolInventoryHash"),
        }


class TrustedProductionDelegationFactory:
    """Build a fresh, owner-bound coordinator for one official run.

    ``owner_factory(env, scenario_id)`` must return a new
    ``NativeAppBinding`` already attached to ``env``.  ``child_factory`` is
    called only after the parent ``before_tool`` decision is ``allow`` and has
    the fixed trusted signature ``(env, scenario_id, owner, scope,
    notification_reader)``.  It must return the runner protocol consumed by
    ``ParentA2ACoordinator`` (``run``, ``close``, ``snapshot``).
    """

    def __init__(self, *, owner_factory: Callable[..., NativeAppBinding],
                 child_factory: Callable[..., Any],
                 registry_factory: Callable[[], ScopedNotificationOriginRegistry] = ScopedNotificationOriginRegistry,
                 child_deadline_seconds: float = 600.0,
                 max_native_actions: int = 100):
        if not callable(owner_factory) or not callable(child_factory) or not callable(registry_factory):
            raise ProductionDelegationError("PRODUCTION_FACTORY_INVALID")
        self.__owner_factory = owner_factory
        self.__child_factory = child_factory
        self.__registry_factory = registry_factory
        self.__child_deadline_seconds = child_deadline_seconds
        self.__max_native_actions = max_native_actions

    def __call__(self, env: Environment, scenario_id: str) -> ProductionDelegationHandle:
        if type(env) is not Environment or type(scenario_id) is not str or not scenario_id:
            raise ProductionDelegationError("PRODUCTION_RUN_ID_INVALID")
        owner = None
        try:
            owner = self.__owner_factory(env, scenario_id)
            if (type(owner) is not NativeAppBinding
                    or owner.clock_environment is not env
                    or env.apps.get(owner.bound_app.name) is not owner.bound_app):
                raise ProductionDelegationError("PRODUCTION_OWNER_INVALID")
            registry = self.__registry_factory()
            if type(registry) is not ScopedNotificationOriginRegistry:
                raise ProductionDelegationError("PRODUCTION_REGISTRY_INVALID")

            def child_factory(*, scope, notification_reader):
                try:
                    return self.__child_factory(env, scenario_id, owner, scope, notification_reader)
                except ProductionDelegationError:
                    raise
                except BaseException:
                    raise ProductionDelegationError("PRODUCTION_CHILD_FACTORY_FAILED") from None

            coordinator = ParentA2ACoordinator(
                env=env, owner=owner, registry=registry,
                child_factory=child_factory,
                child_deadline_seconds=self.__child_deadline_seconds,
                max_native_actions=self.__max_native_actions,
            )
            return ProductionDelegationHandle(coordinator=coordinator, owner=owner, env=env)
        except ProductionDelegationError:
            if owner is not None:
                try:
                    owner.close()
                except BaseException:
                    pass
            raise
        except ParentA2AError:
            if owner is not None:
                try:
                    owner.close()
                except BaseException:
                    pass
            raise ProductionDelegationError("PRODUCTION_COORDINATOR_INVALID") from None
        except BaseException:
            if owner is not None:
                try:
                    owner.close()
                except BaseException:
                    pass
            raise ProductionDelegationError("PRODUCTION_FACTORY_FAILED") from None


def make_production_delegation_factory(*, owner_factory: Callable[..., NativeAppBinding],
                                       child_factory: Callable[..., Any],
                                       registry_factory: Callable[[], ScopedNotificationOriginRegistry] = ScopedNotificationOriginRegistry,
                                       child_deadline_seconds: float = 600.0,
                                       max_native_actions: int = 100) -> TrustedProductionDelegationFactory:
    """Return the explicit trusted bridge configuration object."""
    return TrustedProductionDelegationFactory(
        owner_factory=owner_factory, child_factory=child_factory,
        registry_factory=registry_factory,
        child_deadline_seconds=child_deadline_seconds,
        max_native_actions=max_native_actions,
    )

