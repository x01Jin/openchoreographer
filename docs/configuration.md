# Configuration

```jsonc
{
  "plugins": [
    {
      "package": "openchoreographer",
      "options": {
        "agent": "orchestrator",
        "maxReviewers": 1
      }
    }
  ]
}
```

- `agent`: ID of the primary orchestrator agent.
- `maxReviewers`: reviewer calls per panel including correctness, 1-4, default 1. The cap covers `reviewer` lens calls only; `reviewer-security` is additional when its trigger fires. `1` means the correctness lens only.

`Max parallel` is set in `/choreographer`, stored by the plugin, 1-8 with default 4, and only shapes the delegation hint.

Model overrides and fallbacks are not config options. They are set in the `/choreographer` dialog and stored in the plugin's settings storage; see [models](models.md).
