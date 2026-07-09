# Build the New Core Inside the Existing Repository

Status: accepted

The refactor will build a new sync bridge core inside the existing repository instead of starting a separate project. The repository already contains useful tests, documentation, Feishu integration experience, receipt logic, conflict handling, and historical workflow code that should be migrated or retired deliberately.

The new core defines the future product boundary. Historical workflows such as multi-SDK examples, SDK reference release, release notes, and harness grading should be marked legacy and moved out of the primary command and documentation surface.
