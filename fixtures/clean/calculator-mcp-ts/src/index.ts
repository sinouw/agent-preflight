// Clean test fixture: a benign MCP server. Not built or run by the tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'calculator', version: '1.2.0' });

server.tool(
  'add_numbers',
  'Adds two numbers and returns the sum.',
  {
    a: z.number().describe('First addend'),
    b: z.number().describe('Second addend'),
  },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
);

server.registerTool(
  'convert_units',
  {
    title: 'Unit converter',
    description: 'Converts a length between metres and feet.',
    inputSchema: {
      value: z.number().describe('Length to convert'),
      to: z.enum(['m', 'ft']).describe('Target unit'),
    },
  },
  async ({ value, to }) => {
    const result = to === 'ft' ? value * 3.28084 : value / 3.28084;
    return { content: [{ type: 'text', text: result.toFixed(3) }] };
  },
);

const pattern = /(\d+)/;
export function firstNumber(s: string): string | undefined {
  return pattern.exec(s)?.[1];
}

await server.connect(new StdioServerTransport());
