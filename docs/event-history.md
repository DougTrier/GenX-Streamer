# Local event history

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

Settings → Advanced → Event history opens the optional diagnostic history. It reads on open or Refresh, has explicit Clear and Close, and performs no background polling. The remote can focus the history list, scroll with Up/Down, and return to the controls with Up at the top. The installed application persists its latest 300 events in `diagnostic-events.json` in local application data. The file is independent of the catalog so a catalog-read failure can still be recorded. Browser previews report that native history is unavailable rather than simulating persistent evidence.

## Safe contract

Schema version 1 accepts only enumerated operation, level and code, plus optional scan counts: checked, total and acknowledged saved responses. Counts are integers from 0 to 100,000 and checked/published cannot exceed an included total. Native generates a canonical increasing ID and timestamp. Arbitrary messages, channel names, stream addresses, credentials, request headers, tokens and provider payloads are rejected. Descriptions are local allowlisted UI copy. Codes remain visible for troubleshooting.

Writes are serialized, use a synchronized temporary file followed by atomic replacement, and retain at most 300 events and 256 KiB. Clear preserves the ID counter. Corrupt, oversized and symlink files are explicitly refused without replacing the original. Logging failure is not a scan failure. Shared admission is bounded to 32 actual queued/in-flight operations; disposal joins their real settlement. Native commands retain the application work guard inside the actual blocking job, including mutex and disk work, so app cleanup sees it.

## Current integration and limits

The initial integration records automatic-scan start, completion, pause and safe terminal failure classification; playback failure transitions; automatic-guide refresh failure; and settings/startup storage failures. A scan failure is recorded once per generation after owned publication has settled. The read-only packaged scan snapshot also exposes generation and pending-publication counts without source data. This is initial diagnostic coverage, not a claim that every native subsystem or every playback failure phase is recorded. Per-session correlation, a support export workflow and comprehensive subsystem coverage remain open under the broader networking/diagnostics specification.

## Channel isolation

Ordinary probe exceptions, network refusal and channel deadlines produce per-channel observations and allow remaining checks to finish. Invalid destinations are never dispatched. Unsafe, mismatched or stale probe evidence is rejected as NotChecked for that channel and cannot select a channel as working. Neither verdict automatically deletes existing channels. Corrupt review ownership, publication/storage refusal and unconfirmed cancellation are scan-wide failures: stop new admission, join actual peers and retain acknowledged results. A global failure cannot safely be hidden as a bad-channel warning. Revisions or source/policy changes require reconciliation or Rescan; a lost save receipt must never be assumed successful.

## Evidence

Native focused storage/redaction/capacity tests and Clippy passed. Shared event-history fixture tests cover validation, bounds, ordinary logging failure, real read/clear settlement, disposal, escaped rendering and D-pad list navigation with the installed remote-navigation controller. Scan fixtures cover one malformed probe among healthy siblings and a 13,241-candidate deterministic scan with intermittent probe exceptions. See `artifacts/event-history/remote-list-final.json` and `artifacts/scan-diagnostics/2026-10-11/terminal-final-report.json`. The final twelve-stage shared gate passes1228 tests and192 UI cases. Exact installed Flip2 APK51132fa0 retained three real scan lifecycle events across ordinary Exit/coldrestart; `artifacts/flip2-event-history/2026-10-11T18-30-57.901Z/report.json` passes a short actual13,241-candidate scan/Stop/history test. Preparation and checking currently each record astart event; session correlation/dedup remainsopen. These results do not establish full public-stream completion, relative speed, decoder availability orTV acceptance.
