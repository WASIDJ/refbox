# Refbox platform v1 contract

Go owns platform.sqlite, independent of Pi conversation storage. IDs are opaque strings. Timestamps are ISO UTC. All arrays return [] rather than null. Public endpoints use existing session + CSRF header. Internal endpoints use Bearer REFBOX_PLATFORM_TOKEN, distinct from browser sessions.

## Manifest

GET plugin /manifest: `{schemaVersion:1,id,name,version,description,workspace:{title,path},resources:[{id,name,kind,serviceId,version,environmentId,checks:[{id,url,contains?,json?:{path:string,equals:any},metric?:{name,min},browser?:{selector,text?,passwordEnv?},credentialEnv?}],restartAllowed:boolean}],tools:[{id,name,description,path,method?:GET|POST,mutates:boolean}],events:[string],verification:{checks:[string]}}`. IDs match `[a-zA-Z0-9_-]+`. Plugin base URL derives from manifest URL and is restricted to loopback HTTP. Credentials stay server-side in named environment variable. UI path and tool paths are relative absolute paths. No arbitrary execution commands.

POST /api/platform/plugins `{manifestUrl,credentialEnv?}`. POST /api/platform/plugins/{id}/enable `{enabled:boolean}`. GET /api/platform/plugins/{id}/proxy/{path} is a same-origin authenticated proxy, strips administrator cookies and uses dedicated plugin credentials. POST /api/platform/plugins/{id}/tools/{id} invokes declared tools. Disabled/offline plugins remain visible.

## Snapshot

GET /api/platform/snapshot returns `{plugins,resources,incidents,tasks,workers,evidence,events}`. GET /api/platform/events emits SSE event `snapshot` with same shape independently of Pi availability.

- Plugin `{id,name,version,description,workspace:{title,path},enabled,online,error,manifestUrl,manifest}`
- Resource `{id,pluginId,name,kind,serviceId,version,environmentId,health:'healthy'|'unhealthy'|'unknown'|'stale',sampledAt,method,detail,failures,healthySamples,restartAllowed,checks,enabled}`
- Incident `{id,resourceId,status:'diagnosing'|'acting'|'proving'|'attention'|'closed',openedAt,updatedAt,closedAt?,attempts,actionId,reason,verification:'pending'|'pass'|'fail'|'inconclusive'|'manual',version,environmentId,diagnosisId?,diagnosisStatus?,diagnosisSummary?}`
- Evidence `{id,incidentId,resourceId,actionId,version,environmentId,at,verdict,summary,checks,reviewConversationId,review,monitorSeries?}`. Each HTTP check includes bounded raw response text, full body SHA-256, status and observed assertion values in `witness`; browser checks retain the visible selector/text, final URL and text SHA-256. `monitorSeries` retains three actual consecutive fresh monitoring records, separate from checks executed for this proof.
- Task `{id,conversationId,title,goal,cwd,model,businessStatus:'backlog'|'active'|'attention'|'done',executionStatus,verificationStatus,createdAt,updatedAt,legacyVerified,engineAvailable,manualReason?,acceptedAt?}`. Read-only preservation of historical Pi proof.
- Worker `{id,role,status,lastSeen,detail}`. monitor/prover/executor can be independently offline.
- Event `{id,at,kind,resourceId,incidentId,message}`.

## Tasks

POST /api/platform/tasks forwards creation to Pi then records distinct business ID. GET /api/platform/tasks/{id}/view returns `{view: nativeView, task: nativeTask}`; /artifact proxies to its conversation. POST /api/platform/tasks/{id}/{plan,approve,stop,continue,steer,report} maps business ID to conversation ID. POST /api/platform/tasks/{id}/status `{status}` updates business state; done requires independent pass or explicit manual acceptance (legacy engine verification alone does not count). POST /api/platform/tasks/{id}/accept `{reason}` records actual human inspection and sets done/manual. New execution after acceptance resets the current verdict to pending while retaining the prior acceptance history. Domain task automatic independent proof adapters are future work; current automatic independent proof covers monitoring incidents. Snapshot synchronizes Pi when available, otherwise returns cached states with engineAvailable false.

## Monitoring / actions / proof

POST /internal/heartbeat `{id,role,detail}`.
POST /internal/observations `{resourceId,sampledAt,method,healthy,detail,version,environmentId}`. Monitor obtains resources via GET /internal/resources. GET /internal/observations?resourceId={id} returns current registered resource and actual stored observations for the independent verifier. 15 second collection, 2 failures incident, 3 consecutive healthy samples needed for recovery. Old, future or mismatched resource version/environment observations rejected. stale after 45 seconds. Health and incident closure are distinct.

POST /api/platform/incidents/{id}/repair `{}` invokes named restart through independent broker; maximum 2 per incident. AutoRepair is configured for restartAllowed resources. Pi is optional for recovery. POST /api/platform/incidents/{id}/verify `{}` retries independent proof. POST /api/platform/incidents/{id}/diagnose `{}` creates a Pi diagnostic conversation when executor available; diagnosis cannot invoke shell actions on monitored infrastructure.

Go POST verifier /verify `{incidentId,resourceId,actionId,version,environmentId,requestedAt,checks,healthySamples}`. Verifier reads three actual recent consecutive healthy monitoring records and executes fresh probes plus independent model review through its own Pi DB/conversation, with no infrastructure mutation tools. Returns `{verdict:'pass'|'fail'|'inconclusive'|'manual',summary,checks:[{id,url,passed,detail,sampledAt,completedAt?,witness?}],reviewConversationId,review,monitorSeries}`. The caller's healthySamples counter is not proof. Missing, stale or interrupted monitoring series cannot pass. If model or business checks unavailable, inconclusive. Go binds response to request and stores evidence before closing. No HTTP200-only proof. Proof checks predating the action or wrong resource scope cannot close; preceding monitor samples may predate requestedAt within the freshness window.

Broker POST /restart `{serviceId,actionId}` with separate REFBOX_BROKER_TOKEN; serviceId resolves fixed allowlist map to launchctl domain/label. No caller-provided command/label. Durable action receipt returns same outcome on retry, never repeats an ambiguous restart after crash.

Second plugin is an unrelated personal scratchpad service with its own SQLite data, /manifest, /workspace, declared note tools/events/verification. Monitoring plugin owns observation collection; platform core never gains scratchpad tables.

GET /api/platform/diagnoses/{id} reads the separate durable diagnosis record. Platform caches the latest incident diagnosis status and summary. Plugin SSE is consumed as declared business events; best-effort reconnect does not replace the domain database. Withdrawal/disable prevents observations and action/proof use. Tool method defaults POST; GET input becomes query parameters. Idempotency-Key propagates from public requests or native `pi-tool:<callId>` receipts to plugins.
