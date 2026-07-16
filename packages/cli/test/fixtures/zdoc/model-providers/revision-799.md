# Integrate with Model Providers

A text embedding or reranking model hosted by an external provider cannot be called from Zilliz Cloud until the provider can authenticate requests from your project. A **model provider integration** stores the provider-issued credential at the project level and gives Zilliz Cloud an integration ID that text embedding and reranking features can reference. This avoids placing credentials in individual Function or Ranker configurations.

<div class="alert note">

Creating a model provider integration does not incur charges. The external provider may charge for model inference, and sending data to the provider may incur [data transfer costs](https://zilliverse.feishu.cn/wiki/BClgwKlHaiushBkPPssclTkYnef).

</div>

## Supported model providers

The following model providers can be integrated with Zilliz Cloud:

| Model provider | Supported model types | Required credential |
|-|-|-|
| **OpenAI** | Text embedding models | API key. To obtain one, see the [OpenAI API quickstart](https://developers.openai.com/api/docs/quickstart#create-and-export-an-api-key). |
| **Cohere** | Text embedding and reranking models | API key. To obtain one, see [API Keys and Rate Limits](https://docs.cohere.com/docs/rate-limits). |
| **Voyage AI** | Text embedding and reranking models | API key. To obtain one, see [API Key and Python Client](https://docs.voyageai.com/docs/api-key-and-installation). |
| **Hugging Face** | Text embedding models | User Access Token with **Make calls to Inference Providers** permission. To obtain one, see [Inference Providers](https://huggingface.co/docs/inference-providers/en/index#getting-started). |

## Before you start

Before creating a model provider integration, make sure that:

- You have **Organization Owner** or **Project Admin** permissions for the target Zilliz Cloud project. If you do not have sufficient permissions, contact your Zilliz Cloud Organization Owner.
- You have the credential required by the selected model provider. See [Supported model providers](https://zilliverse.feishu.cn/wiki/B1cSwfWcri4VJLkCR20cHIs6nCf#supported-model-providers).
- If you plan to use Hugging Face, identify an Inference Provider supported by the embedding model you intend to use. Select `hf-inference` to use Hugging Face Serverless Inference API. For partner-routed inference, use the provider name supported by the selected model. Model and provider availability is managed by Hugging Face and may change over time.

## Create an integration in the Zilliz Cloud console

<readonly-block type="isv"></readonly-block>

<Procedures>

To create a model provider integration:

1. Log in to the [Zilliz Cloud console](https://cloud.zilliz.com/login).
2. On your project page, navigate to **Integrations** from the left-side navigation pane.
3. Under the **Model Providers** section, click **+ Integration**.
4. In the dialog box that appears, configure **Basic Settings**:

   - **Model Provider**: Select the model provider to integrate with.
   - **Integration Name**: A unique name for this integration (e.g., `test`).
   - **Integration Description** *(optional)*: A description for this integration (e.g., `for model provider`).
   - **Provider ***(Hugging Face only)*: Select the Hugging Face Inference Provider that serves the embedding model you intend to use. Use `hf-inference` for Hugging Face Serverless Inference API. For partner-routed inference, enter the provider name supported by the selected model.
5. Click **Next**. You'll be redirected to the **Credential Information** step:

   1. Enter the credential required by the selected model provider. For Hugging Face, enter your User Access Token in the **Hugging Face Access Token** field. The same Hugging Face token is used for `hf-inference` and partner-routed inference.
   2. Click **Validate Integration** to check the connection. Once its status changes to Successful, proceed to the next step.
6. Click **Add**.

</Procedures>

Once created, the integration becomes available for use by model-based functions and rankers.

For Hugging Face, **Validate Integration** verifies that Zilliz Cloud can authenticate with the supplied User Access Token. Model existence, Feature Extraction support, compatibility between the selected model and Inference Provider, and vector dimension are validated when you configure or execute a Text Embedding Function. Zilliz Cloud masks the User Access Token after the integration is created.

## Manage integrations

After an integration is created, you can manage it from the **Integrations** page:

- Obtain your integration IDThe integration ID is required when a Text Embedding Function or model-based Ranker uses the integration.
- View integration details
- Edit the integration name or description
- Remove the integration when it is no longer needed

<div class="alert note">

If an integration is removed or becomes invalid, collections or rankers that reference it may fail during insert or search operations until the integration is updated or replaced.

</div>

<readonly-block type="isv"></readonly-block>

## Next steps

After creating a model provider integration, you can:

- Use it with a **Text Embedding Function** to convert text into dense vectors. To use a Hugging Face integration, see [Hugging Face](https://zilliverse.feishu.cn/wiki/ETsNwO7T0iR5GDkvuMxcJG7JnIb).
- Use a Cohere or Voyage AI integration with a model-based Ranker to rerank search results.

For detailed instructions, refer to:

- [Function Overview](https://zilliverse.feishu.cn/wiki/V7xfwDariioU5GkcmfXctzSEnyc)
- [OpenAI](https://zilliverse.feishu.cn/wiki/IrQ2wm2oaiAWl4kqQhkc303Rnlg)
- [Cohere](https://zilliverse.feishu.cn/wiki/WVaVw8J7UiYZ52kaqVUcktqAnAf)
- [Voyage AI](https://zilliverse.feishu.cn/wiki/P4KNwDdqaivEZFk7RpOcYeyhn2N)
- [Hugging Face](https://zilliverse.feishu.cn/wiki/ETsNwO7T0iR5GDkvuMxcJG7JnIb)
- [Cohere Ranker](https://zilliverse.feishu.cn/wiki/Mtxfwvu2fiOLwXkcURCcJxDPnLd)
- [Voyage AI Ranker](https://zilliverse.feishu.cn/wiki/PpGlwYU6PiSsfVkZ7doco50vnKg)
