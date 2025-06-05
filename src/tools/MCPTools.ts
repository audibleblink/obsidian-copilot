import { MCPClientManager } from "@/LLMProviders/mcpClient";
import { getSettings } from "@/settings/model";
import { logError, logInfo } from "@/logger";
import { Notice } from "obsidian";

export class MCPToolsManager {
  private static instance: MCPToolsManager;
  private mcpClient: MCPClientManager;
  private initialized = false;

  private constructor() {
    this.mcpClient = MCPClientManager.getInstance();
  }

  static getInstance(): MCPToolsManager {
    if (!MCPToolsManager.instance) {
      MCPToolsManager.instance = new MCPToolsManager();
    }
    return MCPToolsManager.instance;
  }

  /**
   * Initialize MCP servers from settings
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const settings = getSettings();
      const mcpServers = settings.mcpServers || [];

      for (const serverConfig of mcpServers) {
        if (serverConfig.enabled !== false) {
          this.mcpClient.addServer(serverConfig);
          try {
            await this.mcpClient.connectToServer(serverConfig.name);
          } catch (error) {
            logError(`Failed to connect to MCP server ${serverConfig.name}:`, error);
          }
        }
      }

      this.initialized = true;
      logInfo(`MCP Tools Manager initialized with ${mcpServers.length} servers`);
    } catch (error) {
      logError("Failed to initialize MCP Tools Manager:", error);
    }
  }

  /**
   * Get all available MCP tools formatted for tool discovery
   */
  getAllMCPTools(): Array<{ name: string; description: string; serverName: string }> {
    return this.mcpClient.getAllMCPTools();
  }

  /**
   * Get enabled MCP tools only (excluding disabled ones from settings)
   */
  getEnabledMCPTools(): Array<{ name: string; description: string; serverName: string }> {
    const settings = getSettings();
    const disabledTools = new Set(settings.mcpDisabledTools || []);

    return this.mcpClient.getAllMCPTools().filter((tool) => {
      const toolId = `@mcp-${tool.serverName}-${tool.name}`;
      return !disabledTools.has(toolId);
    });
  }

  /**
   * Execute an MCP tool
   */
  async executeMCPTool(toolName: string, args: any): Promise<any> {
    try {
      // Check if tool is disabled
      const settings = getSettings();
      const disabledTools = new Set(settings.mcpDisabledTools || []);
      if (disabledTools.has(toolName)) {
        throw new Error(`MCP tool ${toolName} is disabled`);
      }

      // Parse tool name to extract server and tool name
      // Format: @mcp-{serverName}-{toolName}
      const match = toolName.match(/^@mcp-(.+?)-(.+)$/);
      if (!match) {
        throw new Error(`Invalid MCP tool name format: ${toolName}`);
      }

      const [, serverName, actualToolName] = match;

      if (!this.mcpClient.isServerConnected(serverName)) {
        throw new Error(`MCP server ${serverName} is not connected`);
      }

      const result = await this.mcpClient.executeTool(serverName, actualToolName, args);
      logInfo(`Executed MCP tool ${actualToolName} on server ${serverName}`);

      return result;
    } catch (error) {
      logError(`Failed to execute MCP tool ${toolName}:`, error);
      throw error;
    }
  }

  /**
   * Check if a tool name is an MCP tool
   */
  isMCPTool(toolName: string): boolean {
    return toolName.startsWith("@mcp-");
  }

  /**
   * Get tool schema for a specific MCP tool
   */
  getMCPToolSchema(toolName: string): any {
    try {
      const match = toolName.match(/^@mcp-(.+?)-(.+)$/);
      if (!match) {
        return null;
      }

      const [, serverName, actualToolName] = match;
      const serverTools = this.mcpClient.getServerTools(serverName);
      const tool = serverTools.find((t) => t.name === actualToolName);

      return tool?.inputSchema || null;
    } catch (error) {
      logError(`Failed to get MCP tool schema for ${toolName}:`, error);
      return null;
    }
  }

  /**
   * Refresh all MCP server connections and tools
   */
  async refreshConnections(): Promise<void> {
    try {
      await this.mcpClient.refreshAllTools();
      logInfo("Refreshed all MCP server connections");
    } catch (error) {
      logError("Failed to refresh MCP connections:", error);
      throw error;
    }
  }

  /**
   * Check if a server is connected
   */
  isServerConnected(serverName: string): boolean {
    return this.mcpClient.isServerConnected(serverName);
  }

  /**
   * Get connection status for all servers
   */
  getConnectionStatus(): Array<{ serverName: string; connected: boolean }> {
    const settings = getSettings();
    const mcpServers = settings.mcpServers || [];

    return mcpServers.map((server) => ({
      serverName: server.name,
      connected: this.mcpClient.isServerConnected(server.name),
    }));
  }

  /**
   * Add a new MCP server configuration
   */
  async addServer(serverConfig: any): Promise<void> {
    try {
      // Test connection first
      const testResult = await this.mcpClient.testConnection(serverConfig);
      if (!testResult) {
        throw new Error("Connection test failed");
      }

      this.mcpClient.addServer(serverConfig);
      await this.mcpClient.connectToServer(serverConfig.name);

      logInfo(`Added and connected to MCP server: ${serverConfig.name}`);
      new Notice(`Successfully connected to MCP server: ${serverConfig.name}`);
    } catch (error) {
      logError(`Failed to add MCP server ${serverConfig.name}:`, error);
      throw error;
    }
  }

  /**
   * Remove an MCP server
   */
  async removeServer(serverName: string): Promise<void> {
    try {
      this.mcpClient.removeServer(serverName);
      logInfo(`Removed MCP server: ${serverName}`);
      new Notice(`Removed MCP server: ${serverName}`);
    } catch (error) {
      logError(`Failed to remove MCP server ${serverName}:`, error);
      throw error;
    }
  }

  /**
   * Get tools from a specific server
   */
  getServerTools(serverName: string): any[] {
    return this.mcpClient.getServerTools(serverName);
  }

  /**
   * Get formatted tool descriptions for UI display
   */
  getToolDescriptions(): Record<string, string> {
    const descriptions: Record<string, string> = {};
    const tools = this.getAllMCPTools();

    tools.forEach((tool) => {
      descriptions[tool.name] = tool.description;
    });

    return descriptions;
  }

  /**
   * Shutdown all MCP connections
   */
  async shutdown(): Promise<void> {
    try {
      await this.mcpClient.disconnectAll();
      this.initialized = false;
      logInfo("MCP Tools Manager shutdown complete");
    } catch (error) {
      logError("Error during MCP Tools Manager shutdown:", error);
    }
  }
}
