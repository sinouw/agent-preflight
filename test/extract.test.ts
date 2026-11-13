import { describe, expect, it } from 'vitest';
import { extractAll } from '../src/extract/index.js';
import { readConcatenated, visualize } from '../src/extract/text.js';
import { memFile } from './helpers.js';

describe('string literal reader', () => {
  it('joins concatenated JS strings and decodes escapes', () => {
    const src = `'a\\n' + "b\\u0041" + \`c\``;
    expect(readConcatenated(src, 0)?.value).toBe('a\nbAc');
  });
  it('reads Python triple-quoted and implicitly concatenated strings', () => {
    expect(readConcatenated('"""x\ny"""', 0, true)?.value).toBe('x\ny');
    expect(readConcatenated('("a" "b")', 1, true)?.value).toBe('ab');
  });
  it('visualizes invisible characters', () => {
    expect(visualize('a​b')).toBe('a<U+200B>b');
  });
});

describe('MCP tool extraction', () => {
  it('reads server.tool and registerTool with zod params', () => {
    const { tools } = extractAll([
      memFile(
        'index.ts',
        `server.tool('alpha', 'Alpha tool', { q: z.string().describe('Query text') }, async () => ({}));
server.registerTool('beta', { description: 'Beta ' + 'tool', inputSchema: { n: z.number().describe('Count') } }, h);`,
      ),
    ]);
    expect(tools.map((t) => [t.name, t.description])).toEqual([
      ['alpha', 'Alpha tool'],
      ['beta', 'Beta tool'],
    ]);
    expect(tools[0]?.params.map((p) => [p.name, p.description])).toEqual([['q', 'Query text']]);
  });

  it('reads FastMCP decorators, docstrings and params', () => {
    const { tools } = extractAll([
      memFile(
        'server.py',
        `@mcp.tool()
def lookup(term: str, limit: int = 5) -> str:
    """Looks up a term."""
    return term

@mcp.tool(name="other", description="Other tool")
def o(x: str):
    pass
`,
      ),
    ]);
    expect(tools.map((t) => t.name)).toEqual(['lookup', 'other']);
    expect(tools[0]?.description).toBe('Looks up a term.');
    expect(tools[0]?.params.map((p) => p.name)).toEqual(['term', 'limit']);
  });

  it('reads JSON tool manifests', () => {
    const { tools } = extractAll([
      memFile(
        'tools.json',
        JSON.stringify({
          tools: [
            {
              name: 'x',
              description: 'X',
              inputSchema: { properties: { a: { description: 'A' } } },
            },
          ],
        }),
      ),
    ]);
    expect(tools[0]?.params[0]).toMatchObject({ name: 'a', description: 'A' });
  });
});

describe('Claude Code config extraction', () => {
  it('extracts hooks, skills and MCP server configs without env values', () => {
    const { definitions, subjects } = extractAll([
      memFile(
        '.claude/settings.json',
        JSON.stringify({
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
        }),
      ),
      memFile('skills/s/SKILL.md', '---\nname: s1\ndescription: Does s.\n---\nBody\n'),
      memFile(
        '.mcp.json',
        JSON.stringify({
          mcpServers: { db: { command: 'db-server', env: { TOKEN: 'secret-value' } } },
        }),
      ),
    ]);
    expect(definitions.map((d) => `${d.kind}:${d.name}`).sort()).toEqual([
      'hook:Stop#0',
      'mcp-server:db',
      'skill:s1',
    ]);
    const server = definitions.find((d) => d.kind === 'mcp-server');
    expect(JSON.stringify(server)).not.toContain('secret-value');
    expect(JSON.stringify(subjects.filter((s) => s.kind === 'mcp-config'))).not.toContain(
      'secret-value',
    );
  });
});
