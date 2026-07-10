# Protect Collaboration State by Default

Status: accepted

Existing Feishu/Lark online documents may contain comments, anchors, block identity, and teammate edits that are part of the value of the document. Feishu Markdown Sync must not silently delete and recreate existing remote documents as the default update path.

The default auto strategy may select no-op, block patch, or section replace when the plan is safe enough. Whole-document replacement remains a first-version capability, but it is a destructive replacement strategy that requires explicit strategy selection, write permission, and destructive confirmation in non-interactive contexts.
