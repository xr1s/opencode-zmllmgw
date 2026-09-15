# ZMLLMGW

An OpenCode plugin that exposes a configurable language-model gateway and
optionally routes models through a secondary compatible endpoint.

## Configuration

Create `~/.config/opencode/zmllmgw/config.yaml`, or set `ZMLLMGW_CONFIG` to a
configuration file:

```yaml
providers:
  gateway:
    endpoint: https://gateway.example
  devmate:
    endpoint: https://secondary.example/api
  admin:
    endpoint: https://account.example

models:
  - gatewayId: example-model
    api: openai-completions
    tools: true
    autoContinue: true
    limit:
      context: 200000
      output: 32000

autoContinue:
  prompt: |-
    上一次回答因输出长度限制被截断。
    请从上一次回答结束的位置继续，不要重复已经输出的内容，继续完成原任务。
    由于存在输出长度限制，如果需要调用工具，请考虑少量多次调用，
    通过多次较短的 tool call 完成同样的任务，避免单次 tool call 过长导致生成失败。
  maxRounds: 15
```

Only `providers.gateway.endpoint` is required. Provider IDs default to
`zmllmgw`, `zmdevmate`, and `zmllmadm`; each can be overridden in its provider
block. The optional secondary and account providers are enabled only when
their endpoints are configured.

Each model may set an optional `limit` block matching the OpenCode model
shape, with `context` (input context window) and `output` (max output tokens);
`input` is also accepted and passed through when provided.

When `autoContinue: true` is set on a model, gateway text-only responses that
finish with `length` are continued automatically as visible user prompts. The
root `autoContinue` block is optional; its default prompt and `maxRounds` of 15
are used when omitted. The feature does not alter the model's output-token
limit, and does not recover truncated tool calls.

Add `opencode-zmllmgw` to the OpenCode plugin list, then use
`/reload-zmllmgw` after changing the configuration.
