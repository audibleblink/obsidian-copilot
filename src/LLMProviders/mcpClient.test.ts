// Mock the MCP SDK modules
const mockConnect = jest.fn();
const mockClose = jest.fn();
const mockRequest = jest.fn();

const MockClient = jest.fn().mockImplementation(() => ({
  connect: mockConnect,
  close: mockClose,
  request: mockRequest,
}));

const MockSSEClientTransport = jest.fn().mockImplementation(() => ({
  close: jest.fn(),
}));

jest.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: MockClient,
}));

jest.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockSSEClientTransport,
}));

jest.mock("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: {},
  CallToolRequestSchema: {},
  ListResourcesRequestSchema: {},
  ReadResourceRequestSchema: {},
}));

import { MCPClientManager, MCPServerConfig } from "./mcpClient";

describe("MCPClientManager", () => {
  let mcpClient: MCPClientManager;

  beforeEach(() => {
    // Get a fresh instance for each test
    mcpClient = MCPClientManager.getInstance();
    // Clear any existing servers
    mcpClient.disconnectAll();
    jest.clearAllMocks();
  });

  afterEach(() => {
    mcpClient.disconnectAll();
  });

  describe("Server Management", () => {
    it("should add and track servers", () => {
      const serverConfig: MCPServerConfig = {
        name: "test-server",
        sseUrl: "http://localhost:3000/sse",
        enabled: false, // Don't auto-connect for this test
      };

      mcpClient.addServer(serverConfig);

      const servers = mcpClient.getAllServerConfigs();
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe("test-server");
    });

    it("should remove servers", async () => {
      const serverConfig: MCPServerConfig = {
        name: "test-server",
        sseUrl: "http://localhost:3000/sse",
        enabled: false,
      };

      mcpClient.addServer(serverConfig);
      expect(mcpClient.getAllServerConfigs()).toHaveLength(1);

      await mcpClient.removeServer("test-server");
      expect(mcpClient.getAllServerConfigs()).toHaveLength(0);
    });

    it("should check server connection status", () => {
      const serverConfig: MCPServerConfig = {
        name: "test-server",
        sseUrl: "http://localhost:3000/sse",
        enabled: false,
      };

      expect(mcpClient.isServerConnected("test-server")).toBe(false);

      mcpClient.addServer(serverConfig);
      expect(mcpClient.isServerConnected("test-server")).toBe(false); // Still false since auto-connect is disabled
    });
  });

  describe("Connection Management", () => {
    it("should connect to servers", async () => {
      const serverConfig: MCPServerConfig = {
        name: "test-server",
        sseUrl: "http://localhost:3000/sse",
        enabled: false,
      };

      // Setup mocks
      mockConnect.mockResolvedValue(undefined);
      mockRequest.mockResolvedValue({ result: { tools: [], resources: [] } });

      mcpClient.addServer(serverConfig);
      await mcpClient.connectToServer("test-server");

      expect(MockSSEClientTransport).toHaveBeenCalledWith(new URL("http://localhost:3000/sse"));
      expect(MockClient).toHaveBeenCalled();
      expect(mockConnect).toHaveBeenCalled();
      expect(mcpClient.isServerConnected("test-server")).toBe(true);
    });

    it("should disconnect from servers", async () => {
      const serverConfig: MCPServerConfig = {
        name: "test-server",
        sseUrl: "http://localhost:3000/sse",
        enabled: false,
      };

      // Setup mocks
      mockConnect.mockResolvedValue(undefined);
      mockClose.mockResolvedValue(undefined);
      mockRequest.mockResolvedValue({ result: { tools: [], resources: [] } });

      mcpClient.addServer(serverConfig);
      await mcpClient.connectToServer("test-server");
      expect(mcpClient.isServerConnected("test-server")).toBe(true);

      await mcpClient.disconnectFromServer("test-server");
      expect(mockClose).toHaveBeenCalled();
      expect(mcpClient.isServerConnected("test-server")).toBe(false);
    });
  });

  describe("Tool Management", () => {
    beforeEach(async () => {
      const serverConfig: MCPServerConfig = {
        name: "test-server",
        sseUrl: "http://localhost:3000/sse",
        enabled: false,
      };

      // Setup mocks for tools
      mockConnect.mockResolvedValue(undefined);
      mockRequest.mockImplementation((request) => {
        if (request.method === "tools/list") {
          return Promise.resolve({
            result: {
              tools: [
                {
                  name: "echo",
                  description: "Echo back the input",
                  inputSchema: { type: "object", properties: { text: { type: "string" } } },
                },
              ],
            },
          });
        }
        if (request.method === "resources/list") {
          return Promise.resolve({ result: { resources: [] } });
        }
        return Promise.resolve({});
      });

      mcpClient.addServer(serverConfig);
      await mcpClient.connectToServer("test-server");
    });

    it("should load tools from connected servers", () => {
      const tools = mcpClient.getAllMCPTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("@mcp-test-server-echo");
      expect(tools[0].description).toBe("[test-server] Echo back the input");
    });

    it("should get tools from specific server", () => {
      const serverTools = mcpClient.getServerTools("test-server");
      expect(serverTools).toHaveLength(1);
      expect(serverTools[0].name).toBe("echo");
    });
  });

  describe("Tool Execution", () => {
    it("should execute tools on servers", async () => {
      const serverConfig: MCPServerConfig = {
        name: "test-server",
        sseUrl: "http://localhost:3000/sse",
        enabled: false,
      };

      const mockResponse = { result: "Hello, World!" };
      mockConnect.mockResolvedValue(undefined);
      mockRequest.mockResolvedValue(mockResponse);

      mcpClient.addServer(serverConfig);
      await mcpClient.connectToServer("test-server");

      const result = await mcpClient.executeTool("test-server", "echo", { text: "Hello, World!" });

      expect(result).toEqual(mockResponse);
      expect(mockRequest).toHaveBeenCalledWith(
        {
          method: "tools/call",
          params: {
            name: "echo",
            arguments: { text: "Hello, World!" },
          },
        },
        {}
      );
    });
  });

  describe("Connection Testing", () => {
    it("should test server connections successfully", async () => {
      mockConnect.mockResolvedValue(undefined);
      mockClose.mockResolvedValue(undefined);
      mockRequest.mockResolvedValue({ result: { tools: [] } });

      const serverConfig: MCPServerConfig = {
        name: "test-server",
        sseUrl: "http://localhost:3000/sse",
      };

      const result = await mcpClient.testConnection(serverConfig);
      expect(result).toBe(true);
      expect(MockSSEClientTransport).toHaveBeenCalledWith(new URL("http://localhost:3000/sse"));
    });

    it("should handle failed connections", async () => {
      mockConnect.mockRejectedValue(new Error("Connection failed"));

      const serverConfig: MCPServerConfig = {
        name: "test-server",
        sseUrl: "http://localhost:3000/sse",
      };

      const result = await mcpClient.testConnection(serverConfig);
      expect(result).toBe(false);
    });
  });
});
