'use strict';

/** OpenAPI 3.1 document for one account (or all accounts when account is null). */
function buildOpenApi({ base, account, accounts }) {
  const server = account ? `${base}/acc/${account.slug}/v1` : `${base}/v1`;
  const models = (accounts || []).map((a) => a.slug);
  const title = account ? `ai2vpn · ${account.name} (${account.provider})` : 'ai2vpn · all accounts';
  return {
    openapi: '3.1.0',
    info: {
      title,
      version: '1.0.0',
      description:
        'OpenAI-compatible Chat Completions API backed by a logged-in web account running inside the ai2vpn container. ' +
        (account
          ? `Authenticate with this account's API key. Model: \`${account.slug}\`.`
          : 'Authenticate with an account API key, or with the master key and pick the account via `model`.'),
    },
    servers: [{ url: server }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'sk-a2v-…' } },
      schemas: {
        Message: {
          type: 'object',
          required: ['role', 'content'],
          properties: {
            role: { type: 'string', enum: ['system', 'developer', 'user', 'assistant'] },
            content: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { $ref: '#/components/schemas/ContentPart' } },
              ],
            },
          },
        },
        ContentPart: {
          description: 'Text, an image, or any file. Files are uploaded into the chat page before the message is sent.',
          oneOf: [
            { type: 'object', required: ['type', 'text'], properties: { type: { const: 'text' }, text: { type: 'string' } } },
            {
              type: 'object',
              required: ['type', 'image_url'],
              properties: {
                type: { const: 'image_url' },
                image_url: { type: 'object', properties: { url: { type: 'string', description: 'data:image/…;base64,… or https://…' } } },
              },
            },
            {
              type: 'object',
              required: ['type', 'file'],
              properties: {
                type: { const: 'file' },
                file: {
                  type: 'object',
                  description: 'Either file_data (base64 or data: URL, with filename) or file_id from POST /files',
                  properties: { filename: { type: 'string' }, file_data: { type: 'string' }, file_id: { type: 'string' } },
                },
              },
            },
          ],
        },
        FileObject: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'file-1a2b3c…' },
            object: { const: 'file' },
            bytes: { type: 'integer' },
            created_at: { type: 'integer' },
            expires_at: { type: 'integer' },
            filename: { type: 'string' },
            purpose: { type: 'string' },
          },
        },
        ChatCompletionRequest: {
          type: 'object',
          required: ['messages'],
          properties: {
            model: models.length ? { type: 'string', enum: models, default: models[0] } : { type: 'string' },
            messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
            stream: { type: 'boolean', default: false },
            stream_options: { type: 'object', properties: { include_usage: { type: 'boolean' } } },
          },
          example: { model: models[0] || 'my-account', messages: [{ role: 'user', content: 'Hello!' }] },
        },
        ChatCompletion: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', const: 'chat.completion' },
            created: { type: 'integer' },
            model: { type: 'string' },
            choices: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  message: { $ref: '#/components/schemas/Message' },
                  finish_reason: { type: 'string' },
                },
              },
            },
            usage: {
              type: 'object',
              description: 'Estimated (characters / 4); web accounts do not report token counts.',
              properties: { prompt_tokens: { type: 'integer' }, completion_tokens: { type: 'integer' }, total_tokens: { type: 'integer' } },
            },
          },
        },
        ModelList: {
          type: 'object',
          properties: {
            object: { type: 'string', const: 'list' },
            data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, object: { type: 'string' }, owned_by: { type: 'string' } } } },
          },
        },
        Error: {
          type: 'object',
          properties: { error: { type: 'object', properties: { message: { type: 'string' }, type: { type: 'string' }, code: { type: 'string' } } } },
        },
      },
    },
    paths: {
      '/chat/completions': {
        post: {
          operationId: 'createChatCompletion',
          summary: 'Create a chat completion',
          description: 'Each call opens a fresh chat in the web UI. Earlier messages are replayed inside the prompt. Set `stream: true` for Server-Sent Events.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatCompletionRequest' } } } },
          responses: {
            200: {
              description: 'Completion (JSON), or an SSE stream of chat.completion.chunk objects when stream=true',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatCompletion' } }, 'text/event-stream': { schema: { type: 'string' } } },
            },
            401: { description: 'Bad API key or the web account is logged out', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            429: { description: 'Too many queued requests', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            502: { description: 'The web UI did not answer as expected', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/files': {
        post: {
          operationId: 'uploadFile',
          summary: 'Upload a file to attach to chats via file_id (kept for FILE_TTL_HOURS, default 24h)',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, purpose: { type: 'string', default: 'user_data' } } },
              },
            },
          },
          responses: { 200: { description: 'Uploaded', content: { 'application/json': { schema: { $ref: '#/components/schemas/FileObject' } } } } },
        },
        get: {
          operationId: 'listFiles',
          summary: 'List uploaded files',
          responses: { 200: { description: 'Files', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/FileObject' } } } } } } } },
        },
      },
      '/files/{file_id}': {
        parameters: [{ name: 'file_id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { operationId: 'getFile', summary: 'File metadata', responses: { 200: { description: 'File', content: { 'application/json': { schema: { $ref: '#/components/schemas/FileObject' } } } } } },
        delete: { operationId: 'deleteFile', summary: 'Delete a file', responses: { 200: { description: 'Deleted' } } },
      },
      '/files/{file_id}/content': {
        parameters: [{ name: 'file_id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { operationId: 'downloadFile', summary: 'Download file content', responses: { 200: { description: 'The file' } } },
      },
      '/models': {
        get: {
          operationId: 'listModels',
          summary: 'List models (one per account)',
          responses: { 200: { description: 'Models', content: { 'application/json': { schema: { $ref: '#/components/schemas/ModelList' } } } } },
        },
      },
    },
  };
}

module.exports = { buildOpenApi };
