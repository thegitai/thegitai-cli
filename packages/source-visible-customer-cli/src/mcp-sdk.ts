import { createRequire } from 'node:module';
import type { Client as ClientType } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  StdioClientTransport as StdioType,
  getDefaultEnvironment as environmentType,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StreamableHTTPClientTransport as HttpType } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AjvJsonSchemaValidator as ValidatorType } from '@modelcontextprotocol/sdk/validation/ajv';

import type { ToolListChangedNotificationSchema as notificationType } from '@modelcontextprotocol/sdk/types.js';

export type Client = ClientType;
export type { JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';

const sdk = createRequire(import.meta.url)('../vendor/mcp/client.cjs') as {
  Client: typeof ClientType;
  StdioClientTransport: typeof StdioType;
  StreamableHTTPClientTransport: typeof HttpType;
  AjvJsonSchemaValidator: typeof ValidatorType;
  getDefaultEnvironment: typeof environmentType;
  ToolListChangedNotificationSchema: typeof notificationType;
};

export const {
  Client,
  StdioClientTransport,
  StreamableHTTPClientTransport,
  AjvJsonSchemaValidator,
  getDefaultEnvironment,
  ToolListChangedNotificationSchema,
} = sdk;
