# resource-sampler-action

Tracks a runner's CPU, memory, I/O wait, disk and network for the length of a
job and draws the timeseries plus a step-timeline waterfall into the job
summary.

## Usage

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      actions: read # for the step waterfall; charts work without it
    steps:
      - uses: ilyalavrenov/resource-sampler-action@v1
      # ... rest of your job ...
```

### OTLP push (optional)

Set `otlp-endpoint` and `otlp-auth` to also send the samples, job duration and
a step-timeline trace to any OTLP-compatible HTTP endpoint. Leave them unset and
you just get the summary. The push is best-effort and never fails the job.

```yaml
      - uses: ilyalavrenov/resource-sampler-action@v1
        with:
          otlp-endpoint: https://otlp.example.com/otlp
          otlp-auth: ${{ secrets.OTLP_AUTH }} # "Basic <base64(...)>"
```

Metrics arrive as `ci_runner_*` gauges, job duration as
`ci_runner_job_duration_seconds`, and each run as a trace of its steps. The
low-cardinality dimensions (`ci_repo`, `ci_workflow`, `ci_job`, `ci_branch`,
`ci_run_id`) go on every datapoint. Commit SHA, runner name and PR number stay
off the metrics to keep the series count down.

## Inputs

| Input           | Default               | Description                                       |
| --------------- | --------------------- | ------------------------------------------------- |
| `interval`      | `5`                   | Seconds between samples.                          |
| `max-points`    | `120`                 | Max points plotted per chart (downsampled to fit).|
| `github-token`  | `${{ github.token }}` | Reads step timings for the waterfall.             |
| `otlp-endpoint` | `""`                  | OTLP/HTTP endpoint. Unset disables the push.      |
| `otlp-auth`     | `""`                  | `Authorization` header for the endpoint.          |

## License

[MIT](LICENSE).
