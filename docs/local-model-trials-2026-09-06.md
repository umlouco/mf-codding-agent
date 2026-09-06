# Strix Halo local model trials

## Current owner instructions and evaluation status

The owner subsequently required **the full VS Code extension only** for model
evaluation, excluded further Qwen comparisons, prioritized larger models and
code quality over speed, and removed the August cutoff for software updates.
The native-core and direct API experiments below are historical diagnostics;
they do not establish a model recommendation under these instructions.

Current trials use the development extension's Task Queue in an isolated copy of
the Plugins workspace. Executor, verifier and supervisor reasoning bindings use
the candidate local model through `https://lemonade.mario-flores.com/v1/`.
The copied unfinished task must produce and execute its Playwright regression
test. Old cloud-written tests and prior validation reports are excluded.
The original application's stopped queue is preserved.

The first full-extension GLM-4.7-Flash Q6_K trial encountered Lemonade 11.8.1's
hardcoded 120-second upstream timeout while processing approximately 32K input
tokens. It made no tool call before the incomplete stream error. This is a
server failure, not a completed model quality result.
[Lemonade 11.9.0](https://github.com/lemonade-sdk/lemonade/releases/tag/v11.9.0)
fixes that timeout and has been installed. The configured server request limit
is now 43,200 seconds; the extension already has no total response deadline.

Large candidates selected for extension trials are
[Mistral Small 4 119B](https://huggingface.co/mistralai/Mistral-Small-4-119B-2603),
[Nemotron 3 Super 120B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16),
and [Devstral 2 123B](https://huggingface.co/mistralai/Devstral-2-123B-Instruct-2512).
Their approximately 75–83 GB Q4 GGUF weights leave substantially more room for
context than full-precision weights on the observed 124 GiB machine. Actual
allocation and full-extension acceptance remain to be verified. The next
configuration increases server context from 65,536 to 131,072 tokens, with
114,688 input tokens allowed before the extension requests a handoff.

The expanded search also selected
[DeepSeek V4 Flash 0731](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731),
the July official release replacing its preview. Its 284B architecture has an
[Unsloth IQ3_XXS quantization](https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF)
totaling 104,207,848,032 bytes. That leaves approximately 27 GiB beyond weights
on this server, before context and working buffers. It is a candidate, not a
proven fit or quality result. The official agentic recommendation uses
temperature 1 and top-p 0.95. It follows Mistral in the sequential download plan.
MiniMax M3's IQ2 weights alone exceed available physical RAM, so it was not
selected for this configuration.

The proxy now uses one shared FIFO completion queue across model names and
aliases, capacity one. Lemonade is limited to one loaded chat model. Switching
models must drain the queue first. Backup configuration and old executables are
retained in `/root/mfagent-upgrade-20260906` on the inference server.

Fedora package updates are complete with no remaining updates from enabled
repositories. Kernel 7.1.13 is running, Mesa is 26.1.8, AMD firmware is 20260810, and
[llama.cpp b10826](https://github.com/ggml-org/llama.cpp/releases/tag/b10826)
Vulkan and CPU backends are installed. The ROCm backend uses the same build
(commit `73a43d1f6`) through an explicit executable wrapper with
[AMD ROCm 10.0.0](https://rocm.docs.amd.com/en/latest/install/rocm.html), including
the `gfx1151` device package. Its executable runs as the Lemonade service user.
The wrapper isolates its ROCm libraries from Fedora's older packaged SDK; the
old backend remains available for rollback. Lemonade's backend inventory can
still display the old managed ROCm version for this custom executable, so the
executable and active process identity are the relevant evidence.

FastFlowLM was updated to 1.0.3. The proxy now uses an isolated Python 3.14.7
environment with FastAPI 0.141.1, Uvicorn 0.52.4, HTTPX 0.28.1 and their resolved
dependencies. Dependency checks and the application health route pass; the
restarted public proxy reports no active completion sessions. Its independent
queue-wait limit was increased from 1,800 to 86,400 seconds. No inference bypass
was introduced. The filesystem now has 984 GiB capacity using previously
unallocated LVM space; existing weights were retained.

Full-extension quality results for the large models are still pending. Runtime
installation and health checks alone do not establish successful coding.

Mistral 119B Q4_K_M loaded successfully with 131,072 context tokens on the new
ROCm backend. The observed process maps resolve HIP and rocBLAS from the ROCm
10.0 installation; one llama-server process is running and swap use is zero.
Trial `mistral119-rocm10-b10826-128k` began at 17:09 UTC. Its full extension
request continued beyond 120 seconds, processed its approximately 33K-token
prompt, and began streaming model output. The extension journals transport
heartbeats separately from decoded model output. These are transport/liveness
observations; implementation and verification are still underway.

In the first Mistral attempt, the executor made two actual `write_file` calls
but no recorded test execution. The first draft has JavaScript errors and
console-only failure reporting; the second is a rewrite. The local supervisor
then requested a corrected task and attempt 2. Its explanation asserted prior
test output that is absent from this trial's tool journal, so that claim is not
accepted as evidence. This replay retains the application's historical task
notes and operational memory; it tests recovery of that queue, rather than a
fresh isolated benchmark. Prior observations must not be mistaken for the
current candidate's results.

The long request queue exposed an extension race: a progress review could apply
a stop/rewrite based on an older file even after the executor produced new tool
results. The existing guard fenced changed task contracts, not changed evidence.
The updated source captures the latest worker-tool event when building
the review prompt, refreshes it after the requirements comparison, and discards
decisions when newer tool starts or results arrive. It preserves execution and
schedules a fresh review, including when a newly launched test is still running.
Heartbeats, reasoning and the supervisor's own reads do not invalidate the
review. All 52 queue progress/retry tests and
TypeScript checking pass. The extension bundle has been rebuilt; the currently
running Mistral trial retains the previously loaded bundle until the next editor
reload, so this fix must not be credited to its earlier behavior.

Attempt 2 subsequently called `testing_environment`, read and edited its spec,
and opened the configured site with `browser_open`. It then tried to fill
`#user_login` on the home page, although the browser result did not show a login
form. `browser_fill` correctly returned a missing-field timeout. Recovery is
still in progress; these tool failures are part of the model result and are not
successful tests. No direct completion benchmark is accepted as a substitute.

During these actual extension requests, Lemonade reported an example turn with
23,235 input tokens, 2,769 output tokens, 219.8 seconds to first token and 17.73
generated tokens/second. This is an observed request, not a controlled speed
comparison or a claim that ROCm is faster than every alternative backend. The
proxy continued to report capacity one. DeepSeek's completed download shards
are hash-verified by Lemonade before the next shard begins.

At 17:53 UTC the Mistral executor actually launched Playwright using the
extension's `unix` tool. It exited 1 with a parser error at line 96 and no tests
executed. The repair remains pending. That run also exposed a tool-output issue:
the Unix shell bridge retained PowerShell progress XML mixed with native
stderr. It now uses the existing shared decoder, preserving the compiler error
and suppressing progress serialization. Regression checks cover mixed output,
serialized errors, progress-only output, and malformed XML preservation.

At 18:04 UTC the next executor replacement was rejected by the read-before-write
guard because another worker had changed the file. Runtime cognition records
678–679 establish that the local **supervisor** successfully called `edit_file`
at 17:59 UTC, despite its inspection-only prompt. This was a coordination defect,
not an unexplained filesystem change. The main queue journal omitted supervisor
tool results; the separate cognition journal preserved the evidence.

The queue was stopped through the extension command after the completed tool
call, with files and all three SQLite stores archived. The extension now enforces
an inspection-only supervisor mode at tool execution as well as tool discovery.
Dedicated reads remain available. File mutations, arbitrary commands and other
mutating tools remain with the executor, which also performs independent
verification in a fresh session. Supervisor tool starts/results are durable in
the main journal. Worker starts now also reach the journal, so an older review
cannot cancel a newly launched test before its result arrives. All 59 queue
tests, TypeScript checking, and the Go agent/tool tests pass. This maintenance
boundary is part of the trial history; continuation preserves the existing work
and is not a fresh benchmark.

## Historical diagnostics (superseded evaluation method)

Owner correction: all inference must use the existing
`https://lemonade.mario-flores.com` proxy and its request queue. Exactly one large
model may be loaded alongside the smaller vision and embedding models. The
temporary direct servers and their tunnels have been stopped; only the existing
vision and embedding workers remained in the process audit. The direct/concurrent
results below are diagnostic records, not production performance rankings.
Further model and model-combination trials must run sequentially through the
proxy. Do not interpret proxy queueing as permission to add concurrent large
models or bypass its scheduler.

The owner's constraint is local execution on a Strix Halo with 128 GB RAM,
including non-web projects. These trials use the actual native MF Agent core and
its tools in separate Go workspaces. Each candidate receives the same CSV ledger
implementation requirements and a public smoke test. Independent acceptance
tests are added only after the model turn ends: exact cents arithmetic, signed
64-bit boundaries, running-sum overflow, CSV quoting, malformed input, and reader
errors. A model's completion claim does not determine the result.

Hardware observed: Ryzen AI MAX+ 395, Radeon 8060S, 16 cores / 32 threads,
124 GiB usable RAM. Installed runtime builds differ: Vulkan b10375 and ROCm
b10394. Comparisons between those installations do not isolate the backend from
the build version. Existing vision and embedding services remain loaded.

Candidates include Devstral Small 2 24B Q6_K and GLM-4.7-Flash Q6_K
(download completion is tracked in the remote pull log). Gemma 4 26B A4B
UD-Q4_K_M was already installed. Qwen3-Coder-Next Q6_K was the preceding queue
executor; it is not the only candidate in this evaluation.

Initial runtime settings: 65,536 context, one slot, all layers on GPU, flash
attention enabled, f16 key/value cache, batch 2048 / microbatch 512, 16 threads.
Temperature/top-p/top-k follow each model's published recommendation where
specified. The initial runs also inherited llama.cpp's min-p=0.05; subsequent
variants explicitly set min-p=0. Runtime property snapshots record the effective
settings. Concurrent quality runs share the GPU, so their elapsed times are not
isolated throughput measurements.

| Observed trial | Result |
| --- | --- |
| Devstral / ROCm b10394 | Repetitive string/type output, zero tool calls. Stopped after observed degeneration; independent Go acceptance failed. |
| Devstral / Vulkan b10375, initial core | Coherent first tool call; subsequent request rejected by the strict chat template. Go implementation remained incomplete. |
| Devstral / Vulkan, fixed-length throughput probe | Two 384-token runs: 11.29 and 11.28 generated tokens/s; short-prompt processing 300 and 278 tokens/s. This is throughput, not task quality. |
| Gemma / Vulkan, unrestricted thinking | Interrupted at 526 seconds with no implementation file produced. Acceptance fails on the untouched stub; this is an interrupted baseline, not a completed quality score. |

The native trial exposed a generic extension protocol defect: cognition injected
an extra user turn amid tool conversations. Joining adjacent user messages fixed
the first continuation but still failed on the second tool round. The corrected
projection attaches temporary observations to the current request or tool result,
preserving message roles, call identities, actual evidence, and durable history.
Regression tests cover multiple consecutive tool rounds and multimodal user
content. The real Devstral rerun proceeds through multiple reads and edits without
the template error. One intermediate harness run omitted editor file callbacks;
it is explicitly excluded from model scoring and was rerun with those callbacks.

Two more transport defects emerged. OpenAI-compatible reasoning was displayed but
not retained in the returned turn, preventing tool continuations from carrying it
back. It is now stored and returned in the observed provider field during the
current tool sequence, then omitted after a new user turn. Also, a clean EOF with
neither a finish reason nor `[DONE]` could become a nominally completed turn.
It now reports an incomplete stream. Tests exercise both cases with actual SSE
responses. New native trials use these fixes; prior results retain their original
build identity.

The next Gemma variant uses a 2048-token reasoning budget and preserved tool-turn
reasoning. A separate Gemma planning response will be supplied to a GLM execution
trial, alongside a standalone GLM trial; both receive the same task requirements.

The Plugins replay remains incomplete. At the comparison checkpoint it has 28
verified tasks, task 29 unverified, and 20 pending. A Claude supervisor was found
to have written task 29's test even though Qwen was the executor. That artifact
is preserved outside the application and excluded from local-model success
evidence. All reasoning/execution roles in the resumed comparison must use local
models; the task must be recreated and independently verified through the queue.

Raw requests, streamed events, generated workspaces, independent test results,
runtime arguments, and intervention records are stored under the private replay's
`artifacts/model-trials` and the remote `mfagent-trials-20260906` directory.

Model/runtime references: [Devstral model card](https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512),
[GLM model card](https://huggingface.co/zai-org/GLM-4.7-Flash),
[Gemma model card](https://huggingface.co/google/gemma-4-26B-A4B-it),
[llama.cpp feature matrix](https://github.com/ggml-org/llama.cpp/wiki/Feature-matrix).
