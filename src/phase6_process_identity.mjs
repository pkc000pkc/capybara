const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const pid = value => Number.isSafeInteger(value) && value > 0
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))
const check = (ok, code) => { if (!ok) throw new Error(`Phase 6 process identity: ${code}`) }

/** Original relative identities only: a relocated archive supplies its own reader. */
export function phase6HttpSessionPaths(session) {
  const output = session?.outputDir?.replaceAll('\\', '/')
  check(typeof output === 'string' && output && !/^(?:\/|[A-Za-z]:)/.test(output)
    && !/[\0:]/.test(output) && !output.split('/').some(part => !part || part === '.' || part === '..'), 'session_output_path_invalid')
  return { journalPath: `${output}/model-http-dispatch.jsonl`, nativeProcessPath: `${output}/process-result.json`, officialEntryPath: `${output}/official-entry/run-manifest.json` }
}

export function verifyPhase6HttpSessionPaths({ session, attestation }) {
  const paths = phase6HttpSessionPaths(session)
  check(object(attestation) && attestation.modelHttpDispatchPath === paths.journalPath
    && attestation.modelHttpDispatchProcessPath === paths.nativeProcessPath
    && attestation.officialEntryPath === paths.officialEntryPath, 'http_session_paths_mismatch')
  return paths
}

/** Verify the sealed, actually observed process generation, not a bare PID/flag. */
export function verifyPhase6NativeProcessIdentity({ nativeProcess: value, officialEntry, pythonProcessId }) {
  check(object(value) && value.schemaVersion === 'gaia2-process-result-v1', 'native_process_schema')
  check(pid(pythonProcessId) && pid(value.pid) && value.pid === pythonProcessId && pid(value.parentPid)
    && value.parentPid !== value.pid && object(officialEntry) && pid(officialEntry.launcherProcessId)
    && value.parentPid === officialEntry.launcherProcessId, 'native_process_pid_binding')
  check(value.exitCode === 0 && value.signal == null && value.timedOut === false && value.interrupted === false
    && value.spawnError == null && value.loggingError == null && value.heartbeatError == null
    && value.manualInspectionRequired === false && value.childExited === true && value.childClosed === true
    && value.supervisionDetached === false && Array.isArray(value.terminationErrors) && value.terminationErrors.length === 0, 'native_process_cleanup')
  const identity = value.processIdentity
  check(object(identity) && identity.verified === true && identity.pid === value.pid && identity.parentPid === value.parentPid, 'native_process_generation_binding')
  check(date(value.startedAt) && date(value.childExitedAt) && date(value.finishedAt)
    && Date.parse(value.startedAt) <= Date.parse(value.childExitedAt) && Date.parse(value.childExitedAt) <= Date.parse(value.finishedAt)
    && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0, 'native_process_terminal_timing')
  if (identity.platform === 'win32') {
    check(date(identity.birthTime) && Date.parse(identity.birthTime) >= Date.parse(value.startedAt) - 5000
      && Date.parse(identity.birthTime) <= Date.parse(value.childExitedAt), 'native_process_birth_missing')
  } else if (identity.platform === 'linux') {
    check(typeof identity.startTicks === 'string' && /^[1-9]\d*$/.test(identity.startTicks), 'native_process_birth_missing')
  } else check(false, 'native_process_platform_unverified')
  return { pid: value.pid, parentPid: value.parentPid, platform: identity.platform,
    ...(identity.platform === 'win32' ? { birthTime: identity.birthTime } : { startTicks: identity.startTicks }), childExited: true, childClosed: true, supervisionDetached: false }
}
