# Configuration

```jsonc
{
  "plugins": [
    {
      "package": "openchoreographer",
      "options": {
        "agent": "orchestrator",
        "maxParallel": 4,
        "maxReviewers": 2
      }
    }
  ]
}
```

- `agent`: ID of the primary orchestrator agent.
- `maxParallel`: background subagents the orchestrator is told to run at once, 1-8, default 4. A prompt-level hint; it enforces nothing.
- `maxReviewers`: reviewer calls per panel including correctness, 1-4, default 2. The cap covers `reviewer` lens calls only; `reviewer-security` is additional when its trigger fires. `1` means the correctness lens only.

Model overrides and fallbacks are not config options. They are set in the `/choreographer` dialog and stored in the plugin's own settings storage; see [models](models.md).
