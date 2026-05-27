<!-- BEGIN BYTEROVER RULES -->
## ByteRover Memory (mandatory)

**Iron Law: QUERY BEFORE THINKING. CURATE AFTER IMPLEMENTING.**

This agent has ByteRover memory available through the `brv` CLI. Before project work, run both commands in parallel:

```bash
brv query "<specific question>" --format json
brv swarm query "<specific question>" --format json
```

Synthesize from both outputs yourself. Treat `brv query` rendered topics as primary project memory and `brv swarm query` fused results as supplemental cross-source recall.

After any meaningful change, discovery, or decision, save the durable insight:

```bash
brv curate "<specific insight>"
```

Use the installed `byterover` skill for the full command guide.
<!-- END BYTEROVER RULES -->
