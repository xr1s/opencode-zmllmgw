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
    limit:
      context: 200000
      output: 32000
```

Only `providers.gateway.endpoint` is required. Provider IDs default to
`zmllmgw`, `zmdevmate`, and `zmllmadm`; each can be overridden in its provider
block. The optional secondary and account providers are enabled only when
their endpoints are configured.

Each model may set an optional `limit` block matching the OpenCode model
shape, with `context` (input context window) and `output` (max output tokens);
`input` is also accepted and passed through when provided.

Add `opencode-zmllmgw` to the OpenCode plugin list, then use
`/reload-zmllmgw` after changing the configuration.
