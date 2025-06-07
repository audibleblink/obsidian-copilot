import { Button } from "@/components/ui/button";
import { SettingItem } from "@/components/ui/setting-item";
import { MCPServerConfig } from "@/LLMProviders/mcpClient";
import { updateSetting, useSettingsValue } from "@/settings/model";
import { MCPToolsManager } from "@/tools/MCPTools";
import { logError } from "@/logger";
import { Notice } from "obsidian";
import React, { useState, useEffect, useCallback, useMemo } from "react";

export const MCPSettings: React.FC = () => {
  const settings = useSettingsValue();
  const [isAdding, setIsAdding] = useState(false);
  const [newServer, setNewServer] = useState<MCPServerConfig>({
    name: "",
    sseUrl: "",
    apiKey: "",
    enabled: true,
  });
  const [mcpTools, setMcpTools] = useState<
    Array<{ name: string; description: string; serverName: string }>
  >([]);

  const mcpServers = useMemo(() => settings.mcpServers || [], [settings.mcpServers]);
  const mcpManager = MCPToolsManager.getInstance();

  // Load tools on component mount and when servers change
  const loadMcpTools = useCallback(async () => {
    try {
      // Ensure MCPToolsManager is initialized
      await mcpManager.initialize();

      // Small delay to allow tools to be loaded from servers
      setTimeout(() => {
        const tools = mcpManager.getAllMCPTools();
        console.log("MCPSettings: Loaded tools:", tools);
        setMcpTools(tools);
      }, 1000); // Give time for server connection and tool loading
    } catch (error) {
      logError("Failed to load MCP tools:", error);
    }
  }, [mcpManager]);

  useEffect(() => {
    loadMcpTools();
  }, [mcpServers, loadMcpTools]); // Reload when servers change

  const addServer = async () => {
    if (!newServer.name.trim() || !newServer.sseUrl.trim()) {
      new Notice("Please provide both server name and SSE URL");
      return;
    }

    try {
      const updatedServers = [...mcpServers, { ...newServer }];
      updateSetting("mcpServers", updatedServers);

      // Try to connect to the new server
      await mcpManager.addServer(newServer);

      // Reset form
      setNewServer({
        name: "",
        sseUrl: "",
        apiKey: "",
        enabled: true,
      });
      setIsAdding(false);

      new Notice(`MCP server "${newServer.name}" added successfully`);

      // Reload tools after adding server
      setTimeout(() => {
        loadMcpTools();
      }, 1000); // Give server time to connect and load tools
    } catch (error) {
      logError("Failed to add MCP server:", error);
      new Notice(
        `Failed to add MCP server: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  };

  const removeServer = async (serverName: string) => {
    try {
      const updatedServers = mcpServers.filter((server) => server.name !== serverName);
      updateSetting("mcpServers", updatedServers);

      // Disconnect from the server
      await mcpManager.removeServer(serverName);

      // Reload tools after removing server
      await loadMcpTools();
    } catch (error) {
      logError("Failed to remove MCP server:", error);
      new Notice(
        `Failed to remove MCP server: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  };

  const toggleServer = async (serverName: string, enabled: boolean) => {
    try {
      const updatedServers = mcpServers.map((server) =>
        server.name === serverName ? { ...server, enabled } : server
      );
      updateSetting("mcpServers", updatedServers);

      if (enabled) {
        const serverConfig = updatedServers.find((s) => s.name === serverName);
        if (serverConfig) {
          await mcpManager.addServer(serverConfig);
        }
      } else {
        await mcpManager.removeServer(serverName);
      }

      new Notice(`MCP server "${serverName}" ${enabled ? "enabled" : "disabled"}`);

      // Reload tools after toggling server
      setTimeout(() => {
        loadMcpTools();
      }, 1000); // Give server time to connect/disconnect
    } catch (error) {
      logError("Failed to toggle MCP server:", error);
      new Notice(
        `Failed to toggle MCP server: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  };

  const testConnection = async (serverConfig: MCPServerConfig) => {
    try {
      const mcpClient = mcpManager["mcpClient"];
      const result = await mcpClient.testConnection(serverConfig);

      if (result) {
        new Notice(`Connection to "${serverConfig.name}" successful!`);
      } else {
        new Notice(`Connection to "${serverConfig.name}" failed!`);
      }
    } catch (error) {
      logError("Failed to test connection:", error);
      new Notice(
        `Connection test failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  };

  const refreshConnections = async () => {
    try {
      await mcpManager.refreshConnections();
      new Notice("MCP connections refreshed");

      // Reload tools after refreshing connections
      setTimeout(() => {
        loadMcpTools();
      }, 1000); // Give time for tools to be reloaded
    } catch (error) {
      logError("Failed to refresh connections:", error);
      new Notice("Failed to refresh connections");
    }
  };

  return (
    <div className="tw-space-y-6">
      {/* Header */}
      <section>
        <h3 className="tw-mb-4 tw-text-lg tw-font-semibold">Model Context Protocol (MCP)</h3>
        <p className="tw-mb-4 tw-text-sm tw-text-faint">
          Configure MCP (Model Context Protocol) servers via Server-Sent Events to extend Copilot
          with external tools and data sources.
        </p>

        <div className="tw-mb-4 tw-flex tw-gap-2">
          <Button
            onClick={() => setIsAdding(true)}
            disabled={isAdding}
            variant="secondary"
            size="sm"
          >
            Add MCP Server
          </Button>
          <Button onClick={refreshConnections} variant="secondary" size="sm">
            Refresh Connections
          </Button>
        </div>
      </section>

      {/* Add New Server Form */}
      {isAdding && (
        <section className="tw-space-y-4 tw-rounded-lg tw-border tw-p-4">
          <h4 className="tw-font-medium">Add New MCP Server</h4>

          <SettingItem
            type="text"
            title="Server Name"
            description="A unique name for this MCP server"
            value={newServer.name}
            onChange={(value) => setNewServer({ ...newServer, name: value })}
            placeholder="my-server"
          />

          <SettingItem
            type="text"
            title="SSE URL"
            description="Server-Sent Events endpoint for the MCP server"
            value={newServer.sseUrl}
            onChange={(value) => setNewServer({ ...newServer, sseUrl: value })}
            placeholder="http://localhost:3000/sse or https://api.example.com/mcp/sse"
          />

          <SettingItem
            type="text"
            title="API Key"
            description="Optional authentication key for the server"
            value={newServer.apiKey || ""}
            onChange={(value) => setNewServer({ ...newServer, apiKey: value })}
            placeholder="your-api-key (optional)"
          />

          <div className="tw-flex tw-gap-2">
            <Button onClick={addServer} size="sm">
              Add Server
            </Button>
            <Button onClick={() => setIsAdding(false)} variant="secondary" size="sm">
              Cancel
            </Button>
          </div>
        </section>
      )}

      {/* Existing Servers */}
      <section>
        <h4 className="tw-mb-4 tw-font-medium">Configured Servers</h4>

        {mcpServers.length === 0 ? (
          <p className="tw-text-sm tw-text-faint">No MCP servers configured</p>
        ) : (
          <div className="tw-space-y-3">
            {mcpServers.map((server, index) => {
              const isConnected = mcpManager.isServerConnected(server.name);

              return (
                <div key={index} className="tw-rounded-lg tw-border tw-p-4">
                  <div className="tw-mb-2 tw-flex tw-items-center tw-justify-between">
                    <div className="tw-flex tw-items-center tw-gap-2">
                      <h5 className="tw-font-medium">{server.name}</h5>
                      <span
                        className={`tw-rounded tw-px-2 tw-py-1 tw-text-xs ${
                          isConnected
                            ? "tw-bg-modifier-success tw-text-on-accent"
                            : "tw-bg-modifier-error tw-text-on-accent"
                        }`}
                      >
                        {isConnected ? "Connected" : "Disconnected"}
                      </span>
                    </div>

                    <div className="tw-flex tw-items-center tw-gap-2">
                      <SettingItem
                        type="switch"
                        title=""
                        description=""
                        checked={server.enabled !== false}
                        onCheckedChange={(enabled) => toggleServer(server.name, enabled)}
                      />
                      <Button onClick={() => testConnection(server)} variant="secondary" size="sm">
                        Test
                      </Button>
                      <Button
                        onClick={() => removeServer(server.name)}
                        variant="destructive"
                        size="sm"
                      >
                        Remove
                      </Button>
                    </div>
                  </div>

                  <div className="tw-text-sm tw-text-faint">
                    <p>
                      <strong>SSE URL:</strong> {server.sseUrl}
                    </p>
                    {server.apiKey && (
                      <p>
                        <strong>API Key:</strong> {"*".repeat(8)}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Available Tools */}
      <section>
        <div className="tw-mb-4 tw-flex tw-items-center tw-justify-between">
          <div>
            <h4 className="tw-font-medium">Available MCP Tools</h4>
            <p className="tw-text-xs tw-text-faint">
              {mcpTools.length} tools from{" "}
              {mcpServers.filter((s) => mcpManager.isServerConnected(s.name)).length} connected
              servers
            </p>
          </div>
          <Button onClick={() => loadMcpTools()} variant="secondary" size="sm">
            Refresh Tools
          </Button>
        </div>
        {(() => {
          if (mcpTools.length === 0) {
            return (
              <p className="tw-text-sm tw-text-faint">No tools available from connected servers</p>
            );
          }

          return (
            <div className="tw-space-y-2">
              {mcpTools.map((tool, index) => (
                <div key={index} className="tw-rounded tw-border tw-p-3">
                  <div className="tw-text-sm tw-font-medium">{tool.name}</div>
                  <div className="tw-text-xs tw-text-faint">{tool.description}</div>
                </div>
              ))}
            </div>
          );
        })()}
      </section>
    </div>
  );
};
