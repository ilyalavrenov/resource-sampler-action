# Security Policy

## Supported Versions

resource-sampler ships tagged releases. The floating `v1` major tag always points
at the latest `v1.x.y` release and receives security fixes; only the latest release
of the current major line is supported. Pin to a commit SHA (with a `# v1` comment)
to control when you pick up fixes.

| Version              | Supported          |
| -------------------- | ------------------ |
| latest `v1` release  | :white_check_mark: |
| older releases       | :x:                |

## Reporting a Vulnerability

Please report security vulnerabilities privately through GitHub's
[**Report a vulnerability**](https://github.com/ilyalavrenov/resource-sampler-action/security/advisories/new)
button (the Security tab → Report a vulnerability). This opens a private advisory
so the issue can be handled before public disclosure. Please do not open a public
issue for a suspected vulnerability.

Include enough to reproduce it: the workflow snippet, the inputs you set, and what
happened. Expect an initial response within a few days; if a report is accepted,
a fix will be released and credited in the advisory.

## Threat model

This is a CI helper action. It runs as a Node step inside your job, samples
`/proc` on the runner, reads this job's step timings from the GitHub Actions API
with the token you pass, and (only when you set `otlp-endpoint` and `otlp-auth`)
POSTs the samples to the OTLP/HTTP endpoint you configure. It has no other network
access, stores nothing outside the runner, and never fails your job on a telemetry
error. The OTLP auth header comes from an input you supply (typically a secret)
and is never logged.
