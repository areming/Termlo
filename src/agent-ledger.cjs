const REMOTE = new Set(['exec_remote','inspect_host','check_runtime','write_file','upload_attachment']);
function initializeLedger(task) {
  task.followups ||= [];
  if (!task.operations) task.operations = task.events.filter(e => REMOTE.has(e.name) && (['running','interrupted','timeout'].includes(e.status) || ['running','interrupted','timeout'].includes(e.result?.status))).map(e => ({ id:e.id, name:e.name, hostId:e.args?.hostId, command:e.args?.command, path:e.args?.path, jobId:e.result?.id, state:'unknown', startedAt:e.at }));
}
function interrupted(task) {
  initializeLedger(task);
  for (const op of task.operations) if (['dispatched','running'].includes(op.state)) op.state='unknown';
  for (const input of task.followups) if (input.status==='delivered') input.status='queued';
}
function settle(task, op, result) {
  if (!op) return;
  op.jobId = result?.id || op.jobId;
  op.state = result?.error || ['timeout','interrupted'].includes(result?.status) ? 'unknown' : result?.status==='running' ? 'running' : result?.status==='failed' ? 'failed' : 'completed';
  op.finishedAt = op.state==='running' ? null : new Date().toISOString();
}
function freshEvidence(task, ids, since, hostId) {
  return task.events.filter(e => {
    if (!ids.includes(e.id) || e.status!=='completed' || !e.result || e.result.error || (e.result.status && e.result.status!=='completed') || (e.result.exitCode!==undefined && e.result.exitCode!==0) || !['inspect_host','check_runtime','read_file','read_job','exec_remote'].includes(e.name) || (since && e.at<since)) return false;
    const sourceHost=e.args?.hostId||e.result.hostId, captured=e.result.finishedAt||e.finishedAt||e.at;
    if(hostId && sourceHost!==hostId)return false;
    // Any later potentially mutating operation invalidates this host's earlier evidence.
    return !(task.operations||[]).some(op=>op.hostId===sourceHost && ['exec_remote','write_file','upload_attachment'].includes(op.name) && op.id!==e.id && !(op.jobId && op.jobId===e.result.id) && (op.finishedAt||op.startedAt)>captured);
  });
}
module.exports = { REMOTE, initializeLedger, interrupted, settle, freshEvidence };
