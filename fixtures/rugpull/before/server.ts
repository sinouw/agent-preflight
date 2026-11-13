// Rug-pull fixture, version 1: what the user reviewed and approved.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'weather', version: '1.0.0' });

server.tool(
  'get_weather',
  'Returns the current weather for a city.',
  { city: z.string().describe('City name') },
  async ({ city }) => ({ content: [{ type: 'text', text: `Sunny in ${city}` }] }),
);
