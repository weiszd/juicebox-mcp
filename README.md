# Juicebox MCP Server

An MCP (Model Context Protocol) server that enables Claude to control Juicebox Hi-C contact map visualizations through natural language. Search for Hi-C datasets, load maps, navigate genomic loci, configure visualizations, and explore chromatin architecture—all through conversation with Claude.

## What is This?

Juicebox MCP Server is derived from the JavaScript version of Juicebox and transforms it into an **AI-powered research assistant** for exploring Hi-C contact maps. Instead of manually navigating web interfaces and configuring visualizations, you can:

- **Search** for Hi-C datasets using natural language ("Show me human K562 cell maps")
- **Load** maps and tracks with intelligent recommendations
- **Navigate** to genomic regions by gene name or coordinates
- **Configure** visualizations through conversation
- **Discover** complementary datasets automatically
- **Share** visualizations via shareable URLs

The server connects Claude Desktop to a browser-based Juicebox frontend, enabling seamless control of Hi-C visualizations through natural language.

## Installation

### Prerequisites

- **Claude Desktop** installed ([Download here](https://claude.ai/download))

### Install the MCP Server

1. **Download the MCP Server Package**
   - Download the `.mcpb` file directly: [juicebox-mcp-20251219-164324.mcpb](https://github.com/aidenlab/juicebox-mcp/blob/main/juicebox-mcp-20251219-164324.mcpb)
   - Or build it yourself (see [Building from Source](#building-from-source) below)

2. **Install in Claude Desktop**
   - Open Claude Desktop
   - Go to **Settings** (macOS: `Cmd + ,` | Windows: `Ctrl + ,`)
   - Navigate to **Developer** → **Add MCP Server**
   - Click **Install from file**
   - Select the `.mcpb` file you downloaded
   - Claude Desktop will automatically extract and configure the server

3. **Verify Installation**
   - The server should appear in your MCP servers list
   - Restart Claude Desktop if needed

That's it! The MCP server is now installed and ready to use.

## Getting Started

### Step 1: Open the Browser Frontend

In Claude Desktop, ask Claude to open Juicebox:

```
You: "Open Juicebox" or "Get the Juicebox URL"
```

Claude will provide a URL—open it in your web browser. The browser will automatically connect to the MCP server running in Claude Desktop.

### Step 2: Start Exploring

Once the browser is open, you can start exploring Hi-C data through natural language:

```
You: "Find Hi-C maps for human K562 cells"

Claude: [Searches available data sources]
        "I found 8 K562 cell line maps. Here are the top results:
        - Map #1: ENCODE K562 Hi-C (hg38, high resolution)
        - Map #2: 4DN K562 Hi-C (hg38, recent data)
        ...
        Which would you like to load?"

You: "Load the first one"

Claude: [Loads the map and displays it in your browser]
```

## Usage Examples

### Search and Load Hi-C Maps

```
You: "Find Hi-C maps for human K562 cells"

Claude: [Searches available data sources]
        "I found 8 K562 cell line maps. Here are the top results..."

You: "Load the first one"

Claude: [Loads the map and displays it in your browser]
```

### Navigate to Genomic Regions

```
You: "Go to the BRCA1 gene"

Claude: [Looks up BRCA1 coordinates]
        [Navigates to chr17:43,044,295-43,125,482]
        "I've navigated to the BRCA1 gene region. Would you like to 
        zoom in or add any annotation tracks?"
```

### Load Complementary Data

```
You: "Add CTCF binding sites for this cell type"

Claude: [Discovers available CTCF tracks for the loaded biosample]
        "I found CTCF ChIP-seq data for K562 cells. Would you like 
        the fold change track or the peak calls?"
        
You: "Both"

Claude: [Loads both tracks]
        "I've added CTCF fold change and peak tracks. The peaks are 
        shown as 2D annotations on the contact map."
```

### Configure Visualization

```
You: "Change the color scale to blue"

Claude: [Updates the foreground color]
        "I've changed the color scale to blue. The contact map now 
        uses a blue gradient to show interaction strength."
```

### Create Shareable Links

```
You: "Create a shareable link for this visualization"

Claude: [Generates a compressed session URL]
        "Here's a shareable link: https://t.3dg.io/abc123
        Anyone can open this link to see your current visualization 
        with all maps, tracks, and settings."
```

## What You Can Do

### 🧠 AI-Enhanced Capabilities

Claude brings intelligent assistance to Hi-C exploration:

- **Semantic Search**: Understands biological concepts ("heart tissue" finds related samples)
- **Context-Aware Discovery**: Suggests complementary datasets based on what you've loaded
- **Domain Knowledge**: Recommends appropriate normalizations, resolutions, and annotations
- **Workflow Orchestration**: Handles multi-step processes automatically
- **Intent Inference**: Makes sensible defaults while allowing full customization

### 🔍 Data Source Integration

Search across multiple Hi-C data sources:

- **4DN (4D Nucleome)**: Specialized 4D nucleome projects
- **ENCODE**: Broad cell type coverage with standardized data

Claude understands metadata relationships and can help you find the right datasets for your research.

### 🎨 Full Visualization Control

Control every aspect of the visualization:

- Load main maps and control maps for comparison
- Navigate by gene name, coordinates, or natural language
- Zoom in/out and pan across the genome
- Configure color scales and normalization methods
- Add 1D tracks (bigWig, bedGraph) and 2D annotations (loops, domains)
- Save and restore sessions
- Create shareable URLs

## Troubleshooting

### Browser Won't Connect

- Make sure Claude Desktop is running
- Verify the MCP server is installed and enabled in Claude Desktop settings
- Try asking Claude: "Get the Juicebox URL" to get a fresh connection URL
- Check that your browser allows WebSocket connections to `localhost`

### Maps Won't Load

- Verify you have an active internet connection (maps are loaded from remote URLs)
- Check that the URL is accessible (try opening it directly in your browser)
- Ask Claude: "Get server status" to check the connection

### Claude Doesn't Recognize Commands

- Make sure the MCP server is enabled in Claude Desktop settings
- Restart Claude Desktop after installing the server
- Check that the server appears in your MCP servers list

## Building from Source

If you want to build the MCP server yourself or contribute to development, see the [MCPB Build Guide](docs/mcp-notes/MCPB_BUILD_GUIDE.md) for detailed instructions.

Quick build steps:

```bash
git clone https://github.com/aidenlab/juicebox-mcp.git
cd juicebox-mcp
npm install
npm run build:mcpb
```

This creates a `.mcpb` package in the project root that can be installed in Claude Desktop.

## Documentation

For more detailed information:

- **[MCP Server Tools](docs/mcp-notes/MCP_SERVER_TOOLS.md)** - Complete tool reference
- **[LLM-Enhanced Capabilities](docs/mcp-notes/LLM_ENHANCED_CAPABILITIES.md)** - What makes AI interaction unique
- **[Data Source AI Capabilities](docs/datasource-notes/DATA_SOURCE_AI_CAPABILITIES.md)** - How data search works
- **[MCPB Build Guide](docs/mcp-notes/MCPB_BUILD_GUIDE.md)** - Building from source
- **[Netlify Setup](docs/mcp-notes/NETLIFY_SETUP.md)** - Frontend deployment guide

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- **Issues**: Report bugs or request features on [GitHub Issues](https://github.com/aidenlab/juicebox-mcp/issues)
- **Documentation**: See the `docs/` folder for detailed guides

## Acknowledgments

Juicebox MCP Server is derived from the JavaScript version of [Juicebox.js](https://github.com/aidenlab/juicebox.js), which provides the core Hi-C visualization capabilities.
