# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-16

Initial release.

### Added

- `/handoff save` — summarize the current thread into `docs/handoffs/current.md`,
  with deterministic secret redaction and Git state capture.
- `/handoff load` — inject the handoff document as a durable recall that is
  immediately visible in the conversation, then have the assistant confirm.
- Assistant confirmation after both `save` and `load`.
