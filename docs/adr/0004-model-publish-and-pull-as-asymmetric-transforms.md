# Model Publish and Pull as Asymmetric Transforms

Status: accepted

Publishing local Markdown to Feishu/Lark and pulling a Feishu/Lark publish draft back to local Markdown are related but not mirror-image operations. Local Markdown may not contain publish-only include tags, while remote Feishu/Lark documents may contain `<include target="milvus">...</include>` and `<include target="zilliz">...</include>` markup used by the Zilliz Cloud publishing flow.

The new core will model this explicitly with publish transforms and pull transforms. Publish transforms can add include tags, rewrite product names, normalize local Markdown, and prepare a Feishu/Lark publish draft; pull transforms can filter include-tagged content and generate a local product view without implying automatic bidirectional sync.
