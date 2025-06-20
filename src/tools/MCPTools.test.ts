// Mock the MCP SDK modules first
jest.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: jest.fn(),
}));

jest.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: jest.fn(),
}));

jest.mock("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: {},
  CallToolRequestSchema: {},
  ListResourcesRequestSchema: {},
  ReadResourceRequestSchema: {},
}));

// Mock Obsidian Notice
jest.mock("obsidian", () => ({
  Notice: jest.fn(),
}));

import { MCPToolsManager } from "./MCPTools";
import { MCPClientManager } from "@/LLMProviders/mcpClient";

// Mock the MCPClientManager
jest.mock("@/LLMProviders/mcpClient");
jest.mock("@/settings/model", () => ({
  getSettings: () => ({
    mcpServers: [],
  }),
}));

const mockMCPClient = {
  getAllMCPTools: jest.fn(),
  isServerConnected: jest.fn(),
  addServer: jest.fn(),
  connectToServer: jest.fn(),
  removeServer: jest.fn(),
  executeTool: jest.fn(),
  refreshAllTools: jest.fn(),
  testConnection: jest.fn(),
  disconnectAll: jest.fn(),
};

(MCPClientManager.getInstance as jest.Mock).mockReturnValue(mockMCPClient);

describe("MCPToolsManager", () => {
  let mcpManager: MCPToolsManager;

  beforeEach(() => {
    mcpManager = MCPToolsManager.getInstance();
    jest.clearAllMocks();
  });

  describe("Tool Management", () => {
    it("should get all MCP tools", () => {
      const mockTools = [
        {
          name: "@mcp-server1-tool1",
          description: "[server1] Tool 1 description",
          serverName: "server1",
        },
      ];

      mockMCPClient.getAllMCPTools.mockReturnValue(mockTools);

      const tools = mcpManager.getAllMCPTools();
      expect(tools).toEqual(mockTools);
      expect(mockMCPClient.getAllMCPTools).toHaveBeenCalled();
    });

    it("should check if tool is MCP tool", () => {
      expect(mcpManager.isMCPTool("@mcp-server1-tool1")).toBe(true);
      expect(mcpManager.isMCPTool("@vault")).toBe(false);
      expect(mcpManager.isMCPTool("regular-tool")).toBe(false);
    });

    it("should get tool descriptions", () => {
      const mockTools = [
        {
          name: "@mcp-server1-tool1",
          description: "[server1] Tool 1",
          serverName: "server1",
        },
        {
          name: "@mcp-server2-tool2",
          description: "[server2] Tool 2",
          serverName: "server2",
        },
      ];

      mockMCPClient.getAllMCPTools.mockReturnValue(mockTools);

      const descriptions = mcpManager.getToolDescriptions();
      expect(descriptions).toEqual({
        "@mcp-server1-tool1": "[server1] Tool 1",
        "@mcp-server2-tool2": "[server2] Tool 2",
      });
    });
  });

  describe("Tool Execution", () => {
    it("should execute MCP tools correctly", async () => {
      const toolName = "@mcp-server1-echo";
      const args = { text: "Hello" };
      const expectedResult = { output: "Hello" };

      mockMCPClient.isServerConnected.mockReturnValue(true);
      mockMCPClient.executeTool.mockResolvedValue(expectedResult);

      const result = await mcpManager.executeMCPTool(toolName, args);

      expect(mockMCPClient.executeTool).toHaveBeenCalledWith("server1", "echo", args);
      expect(result).toEqual(expectedResult);
    });

    it("should throw error for invalid tool name format", async () => {
      await expect(mcpManager.executeMCPTool("invalid-tool", {})).rejects.toThrow(
        "Invalid MCP tool name format: invalid-tool"
      );
    });

    it("should throw error for disconnected server", async () => {
      mockMCPClient.isServerConnected.mockReturnValue(false);

      await expect(mcpManager.executeMCPTool("@mcp-server1-tool", {})).rejects.toThrow(
        "MCP server server1 is not connected"
      );
    });
  });

  describe("Server Management", () => {
    it("should check server connection status", () => {
      mockMCPClient.isServerConnected.mockReturnValue(true);

      const isConnected = mcpManager.isServerConnected("test-server");
      expect(isConnected).toBe(true);
      expect(mockMCPClient.isServerConnected).toHaveBeenCalledWith("test-server");
    });

    it("should add servers", async () => {
      const serverConfig = {
        name: "test-server",
        sseUrl: "http://localhost:3000/sse",
      };

      mockMCPClient.testConnection.mockResolvedValue(true);
      mockMCPClient.addServer.mockImplementation(() => {});
      mockMCPClient.connectToServer.mockResolvedValue(undefined);

      await mcpManager.addServer(serverConfig);

      expect(mockMCPClient.testConnection).toHaveBeenCalledWith(serverConfig);
      expect(mockMCPClient.addServer).toHaveBeenCalledWith(serverConfig);
      expect(mockMCPClient.connectToServer).toHaveBeenCalledWith("test-server");
    });

    it("should handle connection test failures", async () => {
      const serverConfig = {
        name: "test-server",
        sseUrl: "http://localhost:3000/sse",
      };

      mockMCPClient.testConnection.mockResolvedValue(false);

      await expect(mcpManager.addServer(serverConfig)).rejects.toThrow("Connection test failed");
    });

    it("should remove servers", async () => {
      await mcpManager.removeServer("test-server");
      expect(mockMCPClient.removeServer).toHaveBeenCalledWith("test-server");
    });

    it("should refresh connections", async () => {
      await mcpManager.refreshConnections();
      expect(mockMCPClient.refreshAllTools).toHaveBeenCalled();
    });

    it("should shutdown properly", async () => {
      await mcpManager.shutdown();
      expect(mockMCPClient.disconnectAll).toHaveBeenCalled();
    });
  });
});
