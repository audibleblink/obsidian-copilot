import { MCPServerConfig } from "@/LLMProviders/mcpClient";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { updateSetting, useSettingsValue } from "@/settings/model";
import { MCPToolsManager } from "@/tools/MCPTools";
import { App, Modal } from "obsidian";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";

interface MCPToolsPickerModalProps {
  app: App;
  onClose: () => void;
}

interface ToolState {
  serverName: string;
  toolName: string;
  enabled: boolean;
  description: string;
}

interface ServerState {
  name: string;
  enabled: boolean;
  tools: ToolState[];
}

const MCPToolsPickerComponent: React.FC<MCPToolsPickerModalProps> = ({ app, onClose }) => {
  const settings = useSettingsValue();
  const [servers, setServers] = useState<ServerState[]>([]);
  const [loading, setLoading] = useState(true);
  const [alwaysSendTools, setAlwaysSendTools] = useState(settings.mcpAlwaysSendTools || false);

  // Load disabled tools from settings (we'll need to add this field to settings)
  const disabledTools = useMemo(() => {
    return new Set(settings.mcpDisabledTools || []);
  }, [settings.mcpDisabledTools]);

  // Load MCP tools and organize by server
  useEffect(() => {
    const loadTools = async () => {
      try {
        const mcpManager = MCPToolsManager.getInstance();
        await mcpManager.initialize();

        const allTools = mcpManager.getAllMCPTools();
        const mcpServers = settings.mcpServers || [];

        // Group tools by server
        const serverMap = new Map<string, ServerState>();

        mcpServers.forEach((server: MCPServerConfig) => {
          serverMap.set(server.name, {
            name: server.name,
            enabled: server.enabled !== false,
            tools: [],
          });
        });

        allTools.forEach((tool) => {
          const serverState = serverMap.get(tool.serverName);
          if (serverState) {
            // tool.name is already in format @mcp-{serverName}-{toolName}
            const toolId = tool.name;
            // Extract the actual tool name from the prefixed format
            const actualToolName = tool.name.replace(`@mcp-${tool.serverName}-`, "");
            serverState.tools.push({
              serverName: tool.serverName,
              toolName: actualToolName,
              enabled: !disabledTools.has(toolId),
              description: tool.description,
            });
          }
        });

        setServers(Array.from(serverMap.values()));
        setLoading(false);
      } catch (error) {
        console.error("Failed to load MCP tools:", error);
        setLoading(false);
      }
    };

    loadTools();
  }, [settings.mcpServers, disabledTools]);

  // Toggle individual tool
  const toggleTool = useCallback((serverName: string, toolName: string) => {
    setServers((prevServers) => {
      return prevServers.map((server) => {
        if (server.name === serverName) {
          return {
            ...server,
            tools: server.tools.map((tool) => {
              if (tool.toolName === toolName) {
                return { ...tool, enabled: !tool.enabled };
              }
              return tool;
            }),
          };
        }
        return server;
      });
    });
  }, []);

  // Toggle entire server
  const toggleServer = useCallback((serverName: string) => {
    setServers((prevServers) => {
      return prevServers.map((server) => {
        if (server.name === serverName) {
          const newEnabled = !server.enabled;
          return {
            ...server,
            enabled: newEnabled,
            tools: server.tools.map((tool) => ({ ...tool, enabled: newEnabled })),
          };
        }
        return server;
      });
    });
  }, []);

  // Save changes
  const handleSave = useCallback(() => {
    const disabledToolIds = new Set<string>();

    servers.forEach((server) => {
      server.tools.forEach((tool) => {
        if (!tool.enabled) {
          const toolId = `@mcp-${tool.serverName}-${tool.toolName}`;
          disabledToolIds.add(toolId);
        }
      });
    });

    // Update settings with disabled tools
    updateSetting("mcpDisabledTools", Array.from(disabledToolIds));

    // Update always send tools setting
    updateSetting("mcpAlwaysSendTools", alwaysSendTools);

    // Update server enabled states
    const updatedServers = (settings.mcpServers || []).map((server: MCPServerConfig) => {
      const serverState = servers.find((s) => s.name === server.name);
      return {
        ...server,
        enabled: serverState?.enabled ?? server.enabled,
      };
    });
    updateSetting("mcpServers", updatedServers);

    onClose();
  }, [servers, settings.mcpServers, alwaysSendTools, onClose]);

  if (loading) {
    return (
      <div className="tw-flex tw-h-full tw-items-center tw-justify-center tw-p-8">
        <div className="tw-text-muted">Loading MCP tools...</div>
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <div className="tw-flex tw-h-full tw-items-center tw-justify-center tw-p-8">
        <div className="tw-text-center">
          <div className="tw-mb-2 tw-text-muted">No MCP servers configured</div>
          <div className="tw-text-sm tw-text-faint">
            Add MCP servers in the plugin settings to use tools
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tw-flex tw-h-full tw-flex-col">
      <div className="tw-flex-1 tw-overflow-y-auto tw-p-4">
        <div className="tw-mb-6 tw-rounded-md tw-border tw-border-border tw-p-4">
          <div className="tw-flex tw-items-center tw-gap-3">
            <Checkbox
              checked={alwaysSendTools}
              onCheckedChange={(checked) => setAlwaysSendTools(checked as boolean)}
            />
            <div className="tw-flex-1">
              <div className="tw-font-medium">Always send all enabled tools</div>
              <div className="tw-text-sm tw-text-muted">
                Automatically include all enabled MCP tools with every chat message (no @ required)
              </div>
            </div>
          </div>
        </div>
        <div className="tw-space-y-4">
          {servers.map((server) => (
            <div key={server.name} className="tw-rounded-md tw-border tw-border-border tw-p-4">
              <div className="tw-mb-3 tw-flex tw-items-center tw-justify-between">
                <div className="tw-flex tw-items-center tw-gap-2">
                  <Checkbox
                    checked={server.enabled}
                    onCheckedChange={() => toggleServer(server.name)}
                  />
                  <h3 className="tw-font-medium">{server.name}</h3>
                  <span className="tw-text-sm tw-text-muted">
                    ({server.tools.filter((t) => t.enabled).length}/{server.tools.length} tools)
                  </span>
                </div>
              </div>

              {server.tools.length > 0 && (
                <div className="tw-space-y-2 tw-pl-6">
                  {server.tools.map((tool) => (
                    <div
                      key={`${server.name}-${tool.toolName}`}
                      className="tw-flex tw-items-start tw-gap-2"
                    >
                      <Checkbox
                        checked={tool.enabled}
                        disabled={!server.enabled}
                        onCheckedChange={() => toggleTool(server.name, tool.toolName)}
                        className="tw-mt-0.5"
                      />
                      <div className="tw-flex-1">
                        <div className="tw-text-sm tw-font-medium">
                          @mcp-{server.name}-{tool.toolName}
                        </div>
                        {tool.description && (
                          <div className="tw-mt-0.5 tw-text-xs tw-text-muted">
                            {tool.description}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="tw-flex tw-items-center tw-justify-end tw-gap-2 tw-border-t tw-border-border tw-p-4">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSave}>Save Changes</Button>
      </div>
    </div>
  );
};

export class MCPToolsPickerModal extends Modal {
  private root: ReactDOM.Root | null = null;

  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("copilot-mcp-tools-picker-modal");
    contentEl.style.height = "500px";
    contentEl.createEl("h2", { text: "MCP Tools" });

    const container = contentEl.createDiv({ cls: "copilot-mcp-tools-picker-container" });
    container.style.height = "calc(100% - 50px)";
    this.root = ReactDOM.createRoot(container);
    this.root.render(<MCPToolsPickerComponent app={this.app} onClose={() => this.close()} />);
  }

  onClose() {
    if (this.root) {
      this.root.unmount();
    }
    const { contentEl } = this;
    contentEl.empty();
  }
}
