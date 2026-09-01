from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

TOKEN_PATTERN = re.compile(r"[a-z0-9]{3,}")
STOP_TOKENS = {
    "after",
    "and",
    "before",
    "current",
    "from",
    "that",
    "the",
    "then",
    "this",
    "user",
    "when",
    "with",
    "you",
}
GUARD_PATTERN = re.compile(
    r"authori[sz]|ownership|privacy|other account|account owner|unsupported (?:claim|assertion)|"
    r"explicit (?:consent|confirmation)|before (?:committing|mutation)|do not trust|"
    r"authoritative (?:record|result|state)|verify .* after",
    re.IGNORECASE,
)
MUTATION_TOOL_PATTERN = re.compile(
    r"(?:^|_)(?:add|apply|book|cancel|change|create|exchange|process|redeem|refund|remove|"
    r"replace|return|set|submit|update)(?:_|$)",
    re.IGNORECASE,
)
MUTATION_INTENT_PATTERN = re.compile(
    r"\b(?:confirm|go ahead|proceed|do it|apply it|make the change|submit|execute)\b",
    re.IGNORECASE,
)

VALID_PHASES = {"any", "preflight", "decision", "mutation", "verification"}
PHASE_TOKEN_BUDGETS = {
    "preflight": 300,
    "decision": 450,
    "mutation": 250,
    "verification": 350,
}


def _tokens(value: str) -> set[str]:
    return {
        token
        for token in TOKEN_PATTERN.findall(value.lower().replace("_", " "))
        if token not in STOP_TOKENS
    }


def _strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _entry_text(entry: dict[str, Any]) -> str:
    return " ".join(
        [
            str(entry.get("intent", "")),
            str(entry.get("trigger", "")),
            str(entry.get("rule", "")),
            *_strings(entry.get("tools")),
            *_strings(entry.get("tags")),
            *_strings(entry.get("required_evidence", entry.get("requiredEvidence"))),
            *_strings(entry.get("block_when", entry.get("blockWhen"))),
        ]
    )


def _entry_anchor_text(entry: dict[str, Any]) -> str:
    return " ".join(
        [
            str(entry.get("intent", "")),
            *_strings(entry.get("tools")),
            *_strings(entry.get("tags")),
            *_strings(entry.get("required_evidence", entry.get("requiredEvidence"))),
            *_strings(entry.get("block_when", entry.get("blockWhen"))),
        ]
    )


def _entry_mode(entry: dict[str, Any]) -> str:
    mode = str(entry.get("mode", "")).strip().lower()
    if mode in {"guard", "advice"}:
        return mode
    return "guard" if GUARD_PATTERN.search(_entry_text(entry)) else "advice"


def _entry_phase(entry: dict[str, Any], mode: str) -> str:
    phase = str(entry.get("phase", "")).strip().lower()
    if phase in VALID_PHASES:
        return phase
    text = _entry_text(entry).lower()
    if re.search(r"after|post.?mutation|read.?back|resulting state|before claiming", text):
        return "verification"
    if re.search(r"confirm|consent|commit|execute|mutation", text):
        return "mutation"
    if re.search(r"ownership|authori[sz]|privacy|inspect|retrieve|lookup|before", text):
        return "preflight"
    return "any" if mode == "guard" else "decision"


def detect_phase(query: str, tool_names: Iterable[str] = (), initial: bool = False) -> str:
    names = [str(name) for name in tool_names]
    if any(MUTATION_TOOL_PATTERN.search(name) for name in names):
        return "verification"
    if names:
        return "decision"
    if initial:
        return "preflight"
    if MUTATION_INTENT_PATTERN.search(query):
        return "mutation"
    return "decision"


@dataclass
class MemoryPrefetchSelector:
    entries: list[dict[str, Any]]
    domain: str
    release_id: str
    max_snippets: int = 2
    max_loop_tokens: int = 450
    max_run_tokens: int = 1200
    min_advice_overlap: int = 2
    used_ids: list[str] = field(default_factory=list)
    total_injected_tokens: int = 0
    phase_injected_tokens: dict[str, int] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)

    def _rank(
        self,
        query_tokens: set[str],
        tool_tokens: set[str],
        phase: str,
    ) -> list[dict[str, Any]]:
        ranked: list[dict[str, Any]] = []
        for entry in self.entries:
            entry_id = str(entry.get("id", "")).strip()
            entry_domain = str(entry.get("domain", "")).strip()
            if not entry_id or entry_id in self.used_ids or entry_domain not in {"*", self.domain}:
                continue
            mode = _entry_mode(entry)
            entry_phase = _entry_phase(entry, mode)
            if entry_phase not in {"any", phase} and mode != "guard":
                continue
            lexical = len(query_tokens & _tokens(_entry_text(entry)))
            anchor_overlap = len(query_tokens & _tokens(_entry_anchor_text(entry)))
            entry_tool_tokens = _tokens(" ".join(_strings(entry.get("tools"))))
            tool_overlap = len(tool_tokens & entry_tool_tokens)
            relevant = (
                lexical >= 1
                if mode == "guard"
                else (lexical >= self.min_advice_overlap and anchor_overlap >= 1) or tool_overlap > 0
            )
            if not relevant:
                continue
            evidence_count = max(
                1,
                int(entry.get("evidence_count", entry.get("evidenceCount", 1)) or 1),
            )
            confidence = max(0.0, min(1.0, float(entry.get("confidence", 0.5) or 0.5)))
            score = (
                lexical * 4
                + tool_overlap * 8
                + (8 if entry_phase == phase else 3)
                + (6 if entry_domain == self.domain else 5)
                + (3 if mode == "guard" else 0)
                + min(6, round(math.log2(evidence_count + 1) * 2))
                + round(confidence * 4)
            )
            ranked.append(
                {
                    "entry": entry,
                    "id": entry_id,
                    "mode": mode,
                    "phase": entry_phase,
                    "score": score,
                    "lexical": lexical,
                    "anchor_overlap": anchor_overlap,
                    "tool_overlap": tool_overlap,
                    "evidence_count": evidence_count,
                }
            )
        return sorted(ranked, key=lambda item: (-item["score"], item["id"]))

    def _snippet(self, item: dict[str, Any]) -> str:
        entry = item["entry"]
        label = "guard" if item["mode"] == "guard" else "advice"
        lines = [
            f"[{label}:{item['id']} domain={entry.get('domain')} phase={item['phase']} score={item['score']}]",
            f"Trigger: {entry.get('trigger')}",
            f"{'Mandatory rule' if label == 'guard' else 'Procedure'}: {entry.get('rule')}",
        ]
        required = _strings(entry.get("required_evidence", entry.get("requiredEvidence")))
        blocked = _strings(entry.get("block_when", entry.get("blockWhen")))
        if required:
            lines.append(f"Required evidence: {'; '.join(required)}")
        if blocked:
            lines.append(f"Stop when: {'; '.join(blocked)}")
        return "\n".join(lines)

    def select(
        self,
        query: str,
        iteration: int,
        *,
        phase: str | None = None,
        tool_names: Iterable[str] = (),
        initial: bool = False,
    ) -> tuple[str, dict[str, Any]]:
        selected_phase = phase if phase in VALID_PHASES - {"any"} else detect_phase(query, tool_names, initial)
        query_tokens = _tokens(query)
        tool_tokens = _tokens(" ".join(str(name) for name in tool_names))
        ranked = self._rank(query_tokens, tool_tokens, selected_phase)
        phase_used = self.phase_injected_tokens.get(selected_phase, 0)
        phase_limit = PHASE_TOKEN_BUDGETS[selected_phase]
        remaining = max(
            0,
            min(
                self.max_loop_tokens,
                self.max_run_tokens - self.total_injected_tokens,
                phase_limit - phase_used,
            ),
        )
        selected: list[dict[str, Any]] = []
        injected_tokens = 0

        guard = next((item for item in ranked if item["mode"] == "guard"), None)
        ordered = ([guard] if guard else []) + [
            item for item in ranked if item is not guard and item["mode"] == "advice"
        ]
        for item in ordered:
            snippet = self._snippet(item)
            snippet_tokens = max(1, math.ceil(len(snippet) / 4))
            if len(selected) >= self.max_snippets or injected_tokens + snippet_tokens > remaining:
                continue
            selected.append({**item, "snippet": snippet, "tokens": snippet_tokens})
            injected_tokens += snippet_tokens

        selected_ids = [item["id"] for item in selected]
        self.used_ids.extend(selected_ids)
        self.total_injected_tokens += injected_tokens
        self.phase_injected_tokens[selected_phase] = phase_used + injected_tokens
        event = {
            "iteration": iteration,
            "domain": self.domain,
            "phase": selected_phase,
            "release_id": self.release_id,
            "selected_ids": selected_ids,
            "selected_guard_ids": [item["id"] for item in selected if item["mode"] == "guard"],
            "selected_advice_ids": [item["id"] for item in selected if item["mode"] == "advice"],
            "used_ids": list(self.used_ids),
            "injected_tokens": injected_tokens,
            "total_injected_tokens": self.total_injected_tokens,
            "phase_injected_tokens": dict(self.phase_injected_tokens),
            "max_run_tokens": self.max_run_tokens,
            "phase_budget": phase_limit,
            "remaining_tokens": remaining - injected_tokens,
            "eligible_candidates": len(ranked),
            "selections": [
                {
                    "id": item["id"],
                    "mode": item["mode"],
                    "phase": item["phase"],
                    "score": item["score"],
                    "reason": {
                        "domain": self.domain,
                        "lexical_overlap": item["lexical"],
                        "anchor_overlap": item["anchor_overlap"],
                        "tool_overlap": item["tool_overlap"],
                        "evidence_count": item["evidence_count"],
                    },
                    "tokens": item["tokens"],
                }
                for item in selected
            ],
        }
        self.events.append(event)
        return "\n\n".join(item["snippet"] for item in selected), event
