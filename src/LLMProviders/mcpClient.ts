import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { logError, logInfo } from "@/logger";

export interface MCPServerConfig {
  name: string;
  sseUrl: string; // SSE endpoint URL
  apiKey?: string; // Optional authentication
  enabled?: boolean;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * A proper MCP client that communicates with MCP servers via SSE
 * This implementation uses the official MCP SDK with SSE transport
 */
export class MCPClientManager {
  private static instance: MCPClientManager;
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, SSEClientTransport> = new Map();
  private servers: Map<string, MCPServerConfig> = new Map();
  private tools: Map<string, MCPTool[]> = new Map();
  private resources: Map<string, MCPResource[]> = new Map();

  private constructor() {}

  static getInstance(): MCPClientManager {
    if (!MCPClientManager.instance) {
      MCPClientManager.instance = new MCPClientManager();
    }
    return MCPClientManager.instance;
  }

  /**
   * Add an MCP server configuration
   */
  addServer(serverConfig: MCPServerConfig): void {
    this.servers.set(serverConfig.name, serverConfig);
    // Don't auto-connect here - let the caller decide when to connect
    // This prevents duplicate connections during initialization
  }

  /**
   * Remove an MCP server
   */
  async removeServer(serverName: string): Promise<void> {
    await this.disconnectFromServer(serverName);
    this.servers.delete(serverName);
    this.tools.delete(serverName);
    this.resources.delete(serverName);
  }

  /**
   * Connect to an MCP server via SSE
   */
  async connectToServer(serverName: string): Promise<void> {
    const serverConfig = this.servers.get(serverName);
    if (!serverConfig) {
      throw new Error(`Server ${serverName} not found`);
    }

    try {
      // Create SSE transport (skip OAuth for now)
      const transport = new SSEClientTransport(new URL(serverConfig.sseUrl));

      // Create and connect client
      const client = new Client(
        {
          name: "obsidian-copilot",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
            resources: {},
          },
        }
      );

      await client.connect(transport);

      this.clients.set(serverName, client);
      this.transports.set(serverName, transport);

      // Load tools and resources from the server (handle missing methods gracefully)
      await Promise.allSettled([
        this.loadServerTools(serverName),
        this.loadServerResources(serverName),
      ]);

      logInfo(`Connected to MCP server: ${serverName}`);
    } catch (error) {
      logError(`Failed to connect to MCP server ${serverName}:`, error);
      throw error;
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnectFromServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    const transport = this.transports.get(serverName);

    if (client) {
      try {
        await client.close();
        this.clients.delete(serverName);
      } catch (error) {
        logError(`Error closing client for server ${serverName}:`, error);
      }
    }

    if (transport) {
      try {
        await transport.close();
        this.transports.delete(serverName);
      } catch (error) {
        logError(`Error closing transport for server ${serverName}:`, error);
      }
    }

    this.tools.delete(serverName);
    this.resources.delete(serverName);
    logInfo(`Disconnected from MCP server: ${serverName}`);
  }

  /**
   * Load tools from a specific server
   */
  private async loadServerTools(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Client for server ${serverName} not found`);
    }

    try {
      const response = await client.listTools();
      logInfo(`Tools response from ${serverName}:`, response);

      if (response.tools && Array.isArray(response.tools)) {
        const mcpTools: MCPTool[] = response.tools.map((tool: Tool) => ({
          name: tool.name,
          description: tool.description || "",
          inputSchema: tool.inputSchema || {},
        }));

        this.tools.set(serverName, mcpTools);
        logInfo(`Loaded ${mcpTools.length} tools from server: ${serverName}`, mcpTools);
      } else {
        logInfo(`No tools found in response from ${serverName}`);
      }
    } catch (error: any) {
      // Check if it's a "method not found" error
      if (error.code === -32601 || error.message?.includes("Method not found")) {
        logInfo(`Server ${serverName} does not support tools/list_tools method`);
        this.tools.set(serverName, []); // Set empty array to indicate no tools
      } else {
        logError(`Failed to load tools from server ${serverName}:`, error);
      }
    }
  }

  /**
   * Load resources from a specific server
   */
  private async loadServerResources(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Client for server ${serverName} not found`);
    }

    try {
      const response = await client.listResources();

      if (response.resources && Array.isArray(response.resources)) {
        const mcpResources: MCPResource[] = response.resources.map((resource: any) => ({
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
          mimeType: resource.mimeType,
        }));

        this.resources.set(serverName, mcpResources);
        logInfo(`Loaded ${mcpResources.length} resources from server: ${serverName}`);
      }
    } catch (error: any) {
      // Check if it's a "method not found" error
      if (error.code === -32601 || error.message?.includes("Method not found")) {
        logInfo(`Server ${serverName} does not support resources/list method`);
        this.resources.set(serverName, []); // Set empty array to indicate no resources
      } else {
        logError(`Failed to load resources from server ${serverName}:`, error);
      }
    }
  }

  /**
   * Get all available tools across all connected servers
   */
  getAllMCPTools(): Array<{ name: string; description: string; serverName: string }> {
    const allTools: Array<{ name: string; description: string; serverName: string }> = [];

    this.tools.forEach((tools, serverName) => {
      tools.forEach((tool) => {
        allTools.push({
          name: `@mcp-${serverName}-${tool.name}`,
          description: `[${serverName}] ${tool.description}`,
          serverName: serverName,
        });
      });
    });

    return allTools;
  }

  /**
   * Get tools from a specific server
   */
  getServerTools(serverName: string): MCPTool[] {
    return this.tools.get(serverName) || [];
  }

  /**
   * Get resources from a specific server
   */
  getServerResources(serverName: string): MCPResource[] {
    return this.resources.get(serverName) || [];
  }

  /**
   * Execute a tool on a specific server
   */
  async executeTool(serverName: string, toolName: string, arguments_: any): Promise<any> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Client for server ${serverName} not found`);
    }

    try {
      const response = await client.callTool({
        name: toolName,
        arguments: arguments_,
      });

      logInfo(`Executed tool ${toolName} on server ${serverName}`);
      return response;
    } catch (error) {
      logError(`Failed to execute tool ${toolName} on server ${serverName}:`, error);
      throw error;
    }
  }

  /**
   * Read a resource from a specific server
   */
  async readResource(serverName: string, uri: string): Promise<any> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Client for server ${serverName} not found`);
    }

    try {
      const response = await client.readResource({ uri });

      logInfo(`Read resource ${uri} from server ${serverName}`);
      return response;
    } catch (error) {
      logError(`Failed to read resource ${uri} from server ${serverName}:`, error);
      throw error;
    }
  }

  /**
   * Get all connected servers
   */
  getConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Check if a server is connected
   */
  isServerConnected(serverName: string): boolean {
    return this.clients.has(serverName);
  }

  /**
   * Refresh tools and resources from all servers
   */
  async refreshAllTools(): Promise<void> {
    const refreshPromises = Array.from(this.clients.keys()).map(async (serverName) => {
      try {
        await this.loadServerTools(serverName);
        await this.loadServerResources(serverName);
      } catch (error) {
        logError(`Failed to refresh server ${serverName}:`, error);
      }
    });

    await Promise.all(refreshPromises);
  }

  /**
   * Get server configuration
   */
  getServerConfig(serverName: string): MCPServerConfig | undefined {
    return this.servers.get(serverName);
  }

  /**
   * Get all server configurations
   */
  getAllServerConfigs(): MCPServerConfig[] {
    return Array.from(this.servers.values());
  }

  /**
   * Test connection to a server configuration
   */
  async testConnection(serverConfig: MCPServerConfig): Promise<boolean> {
    try {
      // Create a temporary transport and client for testing (skip OAuth)
      const transport = new SSEClientTransport(new URL(serverConfig.sseUrl));

      const client = new Client(
        {
          name: "obsidian-copilot-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
            resources: {},
          },
        }
      );

      await client.connect(transport);

      // Test if we can list tools (but don't fail if method not found)
      try {
        await client.listTools();
      } catch (error: any) {
        if (error.code === -32601 || error.message?.includes("Method not found")) {
          logInfo(
            `Test server does not support tools/list_tools method, but connection is working`
          );
        } else {
          throw error; // Re-throw other errors
        }
      }

      await client.close();
      await transport.close();

      return true;
    } catch (error) {
      logError(`MCP server test connection failed for ${serverConfig.name}:`, error);
      return false;
    }
  }

  /**
   * Disconnect all servers
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.servers.keys()).map((serverName) =>
      this.disconnectFromServer(serverName)
    );
    await Promise.all(disconnectPromises);

    this.servers.clear();
    this.tools.clear();
    this.resources.clear();
    logInfo("Disconnected from all MCP servers");
  }
}
