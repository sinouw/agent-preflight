# Clean test fixture: a benign Python MCP server. Not run by the tests.
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("text-tools")


@mcp.tool()
def word_count(text: str) -> int:
    """Counts the words in a piece of text."""
    return len(text.split())


@mcp.tool(name="reverse_text", description="Reverses the characters of a string.")
def reverse(text: str) -> str:
    return text[::-1]


if __name__ == "__main__":
    mcp.run()
