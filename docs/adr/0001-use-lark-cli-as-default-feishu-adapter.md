# Use Lark CLI as the Default Feishu Adapter

Status: accepted

Feishu Markdown Sync will use the official Lark CLI as the default runtime adapter for Feishu/Lark operations. The project owns the product documentation sync layer: publish profiles, publish and pull transforms, publish plans, receipts, safety gates, and user-facing workflow semantics.

This avoids rebuilding a general Feishu API CLI while still leaving room for direct Open Platform API adapters when the official CLI cannot express a required operation. The existing self-owned Feishu client is legacy for the new core and should not define the default integration path.
