import { getCurrentProject } from "@/aiParams";
import { getStandaloneQuestion } from "@/chainUtils";
import {
  ABORT_REASON,
  AI_SENDER,
  EMPTY_INDEX_ERROR_MESSAGE,
  LOADING_MESSAGES,
  MAX_CHARS_FOR_LOCAL_SEARCH_CONTEXT,
  ModelCapability,
} from "@/constants";
import {
  ImageBatchProcessor,
  ImageContent,
  ImageProcessingResult,
  MessageContent,
} from "@/imageProcessing/imageProcessor";
import { BrevilabsClient } from "@/LLMProviders/brevilabsClient";
import { logInfo, logError } from "@/logger";
import { getSettings, getSystemPrompt } from "@/settings/model";
import { ChatMessage } from "@/sharedState";
import { ToolManager } from "@/tools/toolManager";
import { MCPToolsManager } from "@/tools/MCPTools";
import {
  err2String,
  extractChatHistory,
  extractUniqueTitlesFromDocs,
  extractYoutubeUrl,
  formatDateTime,
  getApiErrorMessage,
  getMessageRole,
  withSuppressedTokenWarnings,
} from "@/utils";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Runnable } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Notice } from "obsidian";
import ChainManager from "./chainManager";
import { COPILOT_TOOL_NAMES, IntentAnalyzer } from "./intentAnalyzer";
import ProjectManager from "./projectManager";

class ThinkBlockStreamer {
  public fullResponse = "";

  constructor(private updateCurrentAiMessage: (message: string) => void) {}

  processChunk(chunk: any) {
    // Trust LangChain to provide standardized content
    if (chunk.content) {
      if (typeof chunk.content === "string") {
        this.fullResponse += chunk.content;
      } else if (Array.isArray(chunk.content)) {
        // Handle array content (text blocks)
        for (const item of chunk.content) {
          if (item.type === "text" && item.text) {
            this.fullResponse += item.text;
          }
        }
      }
    }

    this.updateCurrentAiMessage(this.fullResponse);
  }

  close() {
    return this.fullResponse;
  }
}

export interface ChainRunner {
  run(
    userMessage: ChatMessage,
    abortController: AbortController,
    updateCurrentAiMessage: (message: string) => void,
    addMessage: (message: ChatMessage) => void,
    options: {
      debug?: boolean;
      ignoreSystemMessage?: boolean;
      updateLoading?: (loading: boolean) => void;
      updateLoadingMessage?: (message: string) => void;
    }
  ): Promise<string>;
}

abstract class BaseChainRunner implements ChainRunner {
  protected chainManager: ChainManager;

  constructor(chainManager: ChainManager) {
    this.chainManager = chainManager;
  }

  abstract run(
    userMessage: ChatMessage,
    abortController: AbortController,
    updateCurrentAiMessage: (message: string) => void,
    addMessage: (message: ChatMessage) => void,
    options: {
      debug?: boolean;
      ignoreSystemMessage?: boolean;
      updateLoading?: (loading: boolean) => void;
      updateLoadingMessage?: (message: string) => void;
    }
  ): Promise<string>;

  protected async handleResponse(
    fullAIResponse: string,
    userMessage: ChatMessage,
    abortController: AbortController,
    addMessage: (message: ChatMessage) => void,
    updateCurrentAiMessage: (message: string) => void,
    debug: boolean,
    sources?: { title: string; score: number }[]
  ) {
    if (fullAIResponse && abortController.signal.reason !== ABORT_REASON.NEW_CHAT) {
      // Include tool results in the saved context if they exist
      let contextToSave = fullAIResponse;
      const toolResults = (this as any).lastToolResults;

      if (toolResults && toolResults.length > 0) {
        // Prepend tool results to the response for context
        const toolResultsText = toolResults
          .map((result: any) => `[Tool ${result.name} Result: ${result.content}]`)
          .join("\n");
        contextToSave = `${toolResultsText}\n\n${fullAIResponse}`;

        // Clear the tool results after using them
        (this as any).lastToolResults = null;
      }

      await this.chainManager.memoryManager
        .getMemory()
        .saveContext({ input: userMessage.message }, { output: contextToSave });

      addMessage({
        message: fullAIResponse,
        sender: AI_SENDER,
        isVisible: true,
        timestamp: formatDateTime(new Date()),
        sources: sources,
      });
    }
    updateCurrentAiMessage("");
    if (debug) {
      console.log(
        "==== Chat Memory ====\n",
        (this.chainManager.memoryManager.getMemory().chatHistory as any).messages.map(
          (m: any) => m.content
        )
      );
      console.log("==== Final AI Response ====\n", fullAIResponse);
    }
    return fullAIResponse;
  }

  protected async handleError(
    error: any,
    debug: boolean,
    addMessage?: (message: ChatMessage) => void,
    updateCurrentAiMessage?: (message: string) => void
  ) {
    const msg = err2String(error);
    if (debug) console.error("Error during LLM invocation:", msg);
    const errorData = error?.response?.data?.error || msg;
    const errorCode = errorData?.code || msg;
    let errorMessage = "";

    // Check for specific error messages
    if (error?.message?.includes("Invalid license key")) {
      errorMessage = "Invalid Copilot Plus license key. Please check your license key in settings.";
    } else if (errorCode === "model_not_found") {
      errorMessage =
        "You do not have access to this model or the model does not exist, please check with your API provider.";
    } else {
      errorMessage = `${errorCode}`;
    }

    console.error(errorData);

    if (addMessage && updateCurrentAiMessage) {
      updateCurrentAiMessage("");

      // remove langchain troubleshooting URL from error message
      const ignoreEndIndex = errorMessage.search("Troubleshooting URL");
      errorMessage = ignoreEndIndex !== -1 ? errorMessage.slice(0, ignoreEndIndex) : errorMessage;

      // add more user guide for invalid API key
      if (msg.search(/401|invalid|not valid/gi) !== -1) {
        errorMessage =
          "Something went wrong. Please check if you have set your API key." +
          "\nPath: Settings > copilot plugin > Basic Tab > Set Keys." +
          "\nOr check model config" +
          "\nError Details: " +
          errorMessage;
      }

      addMessage({
        message: errorMessage,
        isErrorMessage: true,
        sender: AI_SENDER,
        isVisible: true,
        timestamp: formatDateTime(new Date()),
      });
    } else {
      // Fallback to Notice if message handlers aren't provided
      new Notice(errorMessage);
      console.error(errorData);
    }
  }
}

class LLMChainRunner extends BaseChainRunner {
  async run(
    userMessage: ChatMessage,
    abortController: AbortController,
    updateCurrentAiMessage: (message: string) => void,
    addMessage: (message: ChatMessage) => void,
    options: {
      debug?: boolean;
      ignoreSystemMessage?: boolean;
      updateLoading?: (loading: boolean) => void;
      updateLoadingMessage?: (message: string) => void;
    }
  ): Promise<string> {
    const { debug = false } = options;
    const streamer = new ThinkBlockStreamer(updateCurrentAiMessage);

    try {
      const chain = this.chainManager.getChain();
      const chatStream = await chain.stream({
        input: userMessage.message,
      } as any);

      for await (const chunk of chatStream) {
        if (abortController.signal.aborted) break;
        streamer.processChunk(chunk);
      }
    } catch (error) {
      await this.handleError(error, debug, addMessage, updateCurrentAiMessage);
    }

    return this.handleResponse(
      streamer.close(),
      userMessage,
      abortController,
      addMessage,
      updateCurrentAiMessage,
      debug
    );
  }
}

class VaultQAChainRunner extends BaseChainRunner {
  async run(
    userMessage: ChatMessage,
    abortController: AbortController,
    updateCurrentAiMessage: (message: string) => void,
    addMessage: (message: ChatMessage) => void,
    options: {
      debug?: boolean;
      ignoreSystemMessage?: boolean;
      updateLoading?: (loading: boolean) => void;
      updateLoadingMessage?: (message: string) => void;
    }
  ): Promise<string> {
    const { debug = false } = options;
    let fullAIResponse = "";

    try {
      // Add check for empty index
      const indexEmpty = await this.chainManager.vectorStoreManager.isIndexEmpty();
      if (indexEmpty) {
        return this.handleResponse(
          EMPTY_INDEX_ERROR_MESSAGE,
          userMessage,
          abortController,
          addMessage,
          updateCurrentAiMessage,
          debug
        );
      }

      const memory = this.chainManager.memoryManager.getMemory();
      const memoryVariables = await memory.loadMemoryVariables({});
      const chatHistory = extractChatHistory(memoryVariables);
      const qaStream = await this.chainManager.getRetrievalChain().stream({
        question: userMessage.message,
        chat_history: chatHistory,
      } as any);

      for await (const chunk of qaStream) {
        if (abortController.signal.aborted) break;
        fullAIResponse += chunk.content;
        updateCurrentAiMessage(fullAIResponse);
      }

      fullAIResponse = this.addSourcestoResponse(fullAIResponse);
    } catch (error) {
      await this.handleError(error, debug, addMessage, updateCurrentAiMessage);
    }

    return this.handleResponse(
      fullAIResponse,
      userMessage,
      abortController,
      addMessage,
      updateCurrentAiMessage,
      debug
    );
  }

  private addSourcestoResponse(response: string): string {
    const docTitles = extractUniqueTitlesFromDocs(this.chainManager.getRetrievedDocuments());
    if (docTitles.length > 0) {
      const links = docTitles.map((title) => `- [[${title}]]`).join("\n");
      response += "\n\n#### Sources:\n\n" + links;
    }
    return response;
  }
}

class CopilotPlusChainRunner extends BaseChainRunner {
  private isYoutubeOnlyMessage(message: string): boolean {
    const trimmedMessage = message.trim();
    const hasYoutubeCommand = trimmedMessage.includes("@youtube");
    const youtubeUrl = extractYoutubeUrl(trimmedMessage);

    // Check if message only contains @youtube command and a valid URL
    const words = trimmedMessage
      .split(/\s+/)
      .filter((word) => word !== "@youtube" && word.length > 0);

    return hasYoutubeCommand && youtubeUrl !== null && words.length === 1;
  }

  private async processImageUrls(urls: string[]): Promise<ImageProcessingResult> {
    const failedImages: string[] = [];
    const processedImages = await ImageBatchProcessor.processUrlBatch(
      urls,
      failedImages,
      this.chainManager.app.vault
    );
    ImageBatchProcessor.showFailedImagesNotice(failedImages);
    return processedImages;
  }

  private async processChatInputImages(content: MessageContent[]): Promise<ImageProcessingResult> {
    const failedImages: string[] = [];
    const processedImages = await ImageBatchProcessor.processChatImageBatch(
      content,
      failedImages,
      this.chainManager.app.vault
    );
    ImageBatchProcessor.showFailedImagesNotice(failedImages);
    return processedImages;
  }

  private async extractEmbeddedImages(content: string): Promise<string[]> {
    const imageRegex = /!\[\[(.*?\.(png|jpg|jpeg|gif|webp|bmp|svg))\]\]/g;
    const matches = [...content.matchAll(imageRegex)];
    const images = matches.map((match) => match[1]);
    return images;
  }

  private async buildMessageContent(
    textContent: string,
    userMessage: ChatMessage
  ): Promise<MessageContent[]> {
    const failureMessages: string[] = [];
    const successfulImages: ImageContent[] = [];
    const settings = getSettings();

    // Collect all image sources
    const imageSources: { urls: string[]; type: string }[] = [];

    // Safely check and add context URLs
    const contextUrls = userMessage.context?.urls;
    if (contextUrls && contextUrls.length > 0) {
      imageSources.push({ urls: contextUrls, type: "context" });
    }

    // Process embedded images only if setting is enabled
    if (settings.passMarkdownImages) {
      const embeddedImages = await this.extractEmbeddedImages(textContent);
      if (embeddedImages.length > 0) {
        imageSources.push({ urls: embeddedImages, type: "embedded" });
      }
    }

    // Process all image sources
    for (const source of imageSources) {
      const result = await this.processImageUrls(source.urls);
      successfulImages.push(...result.successfulImages);
      failureMessages.push(...result.failureDescriptions);
    }

    // Process existing chat content images if present
    const existingContent = userMessage.content;
    if (existingContent && existingContent.length > 0) {
      const result = await this.processChatInputImages(existingContent);
      successfulImages.push(...result.successfulImages);
      failureMessages.push(...result.failureDescriptions);
    }

    // Let the LLM know about the image processing failures
    let finalText = textContent;
    if (failureMessages.length > 0) {
      finalText = `${textContent}\n\nNote: \n${failureMessages.join("\n")}\n`;
    }

    const messageContent: MessageContent[] = [
      {
        type: "text",
        text: finalText,
      },
    ];

    // Add successful images after the text content
    if (successfulImages.length > 0) {
      messageContent.push(...successfulImages);
    }

    return messageContent;
  }

  private hasCapability(model: BaseChatModel, capability: ModelCapability): boolean {
    const modelName = (model as any).modelName || (model as any).model || "";
    const customModel = this.chainManager.chatModelManager.findModelByName(modelName);
    return customModel?.capabilities?.includes(capability) ?? false;
  }

  private isMultimodalModel(model: BaseChatModel): boolean {
    return this.hasCapability(model, ModelCapability.VISION);
  }

  /**
   * Detect MCP tools mentioned in user message
   */
  private detectMCPTools(message: string): string[] {
    const mcpManager = MCPToolsManager.getInstance();
    const allMCPTools = mcpManager.getAllMCPTools();
    const mentionedTools: string[] = [];

    for (const mcpTool of allMCPTools) {
      if (message.toLowerCase().includes(mcpTool.name.toLowerCase())) {
        mentionedTools.push(mcpTool.name);
      }
    }

    return mentionedTools;
  }

  /**
   * Convert MCP tools to LangChain tool format for function calling
   */
  private async getMCPToolDefinitions(toolNames: string[]): Promise<any[]> {
    const mcpManager = MCPToolsManager.getInstance();
    const toolDefinitions: any[] = [];

    for (const toolName of toolNames) {
      // Parse tool name: @mcp-{serverName}-{toolName}
      const match = toolName.match(/^@mcp-(.+?)-(.+)$/);
      if (!match) continue;

      const [, serverName, actualToolName] = match;

      // Validate that actualToolName is not empty
      if (!actualToolName || actualToolName.trim().length === 0) {
        logError(`Invalid tool name format: ${toolName} - tool name part is empty`);
        continue;
      }

      // Get tool details from server
      const serverTools = mcpManager.getServerTools(serverName);
      const mcpTool = serverTools.find((t: any) => t.name === actualToolName);

      if (mcpTool) {
        // Ensure the MCP tool has a valid name
        const validToolName =
          mcpTool.name && mcpTool.name.trim().length > 0 ? mcpTool.name : actualToolName;

        // Convert JSON schema to Zod schema
        const zodSchema = this.jsonSchemaToZod(
          mcpTool.inputSchema || {
            type: "object",
            properties: {},
            required: [],
          }
        );

        // Create a proper LangChain tool
        const langchainTool = tool(
          async (args: any) => {
            // This function will be called when the tool is invoked
            return await mcpManager.executeMCPTool(toolName, args);
          },
          {
            name: validToolName,
            description: mcpTool.description || `MCP tool: ${validToolName}`,
            schema: zodSchema,
          }
        );

        // Add metadata to the tool instance
        (langchainTool as any)._mcpServerName = serverName;
        (langchainTool as any)._mcpToolName = toolName;

        toolDefinitions.push(langchainTool);
      }
    }

    return toolDefinitions;
  }

  /**
   * Helper method to convert JSON Schema to Zod (basic implementation)
   */
  private jsonSchemaToZod(jsonSchema: any): z.ZodType<any> {
    if (jsonSchema.type === "object") {
      const shape: any = {};

      if (jsonSchema.properties) {
        for (const [key, value] of Object.entries(jsonSchema.properties)) {
          const propSchema = value as any;
          if (propSchema.type === "string") {
            shape[key] = z.string();
          } else if (propSchema.type === "number") {
            shape[key] = z.number();
          } else if (propSchema.type === "boolean") {
            shape[key] = z.boolean();
          } else if (propSchema.type === "array") {
            shape[key] = z.array(z.any());
          } else {
            shape[key] = z.any();
          }

          // Make optional if not required
          if (!jsonSchema.required?.includes(key)) {
            shape[key] = shape[key].optional();
          }
        }
      }

      return z.object(shape);
    }

    return z.any();
  }

  /**
   * Strip MCP tool mentions from user message
   */
  private stripMCPMentions(message: string): string {
    const mcpManager = MCPToolsManager.getInstance();
    const allMCPTools = mcpManager.getAllMCPTools();
    const mcpToolNames = allMCPTools.map((tool) => tool.name.toLowerCase());

    return message
      .split(" ")
      .filter((word) => !mcpToolNames.includes(word.toLowerCase()))
      .join(" ")
      .trim();
  }

  /**
   * Execute MCP tools from LLM tool calls
   */
  private async executeMCPTools(toolCalls: any[], mentionedMCPTools: string[]): Promise<any[]> {
    const mcpManager = MCPToolsManager.getInstance();
    const results: any[] = [];

    for (const toolCall of toolCalls) {
      try {
        logInfo(`Incoming tool_call: ${JSON.stringify(toolCall)}`);
        // Ensure we have required fields (LangChain doesn't always provide them)
        const toolCallId =
          toolCall.id || `tool_call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const toolName = toolCall.name || "unknown_tool";

        // Handle different formats of tool arguments
        // LangChain might provide args in different ways depending on the provider
        let toolArgs = {};
        if (toolCall.args && typeof toolCall.args === "object") {
          toolArgs = toolCall.args;
        } else if (toolCall.input && typeof toolCall.input === "object") {
          toolArgs = toolCall.input;
        } else if (typeof toolCall === "object") {
          // Sometimes the entire toolCall object might be the args
          const { ...restArgs } = toolCall;
          if (Object.keys(restArgs).length > 0) {
            toolArgs = restArgs;
          }
        }

        logInfo(`Extracted tool args: ${JSON.stringify(toolArgs)}`);

        // Find the corresponding MCP tool
        const mcpToolName = mentionedMCPTools.find((name) => name.includes(toolName));

        if (mcpToolName) {
          logInfo(`Executing MCP tool: ${mcpToolName} with args:`, toolArgs);
          const result = await mcpManager.executeMCPTool(mcpToolName, toolArgs);

          results.push({
            tool_call_id: toolCallId,
            tool_name: toolName,
            output: result,
          });
        } else {
          logError("Could not find matching MCP tool for:", toolCall);
          results.push({
            tool_call_id: toolCallId,
            tool_name: toolName,
            output: { error: "Tool not found" },
          });
        }
      } catch (error) {
        logError("Error executing MCP tool:", error);
        results.push({
          tool_call_id: toolCall.id || "unknown",
          tool_name: toolCall.name || "unknown",
          output: { error: err2String(error) },
        });
      }
    }

    return results;
  }

  protected async streamMultimodalResponse(
    textContent: string,
    userMessage: ChatMessage,
    abortController: AbortController,
    updateCurrentAiMessage: (message: string) => void,
    debug: boolean
  ): Promise<string> {
    // Detect MCP tools in the original user message
    const originalMessage = userMessage.originalMessage || userMessage.message;
    const mentionedMCPTools = this.detectMCPTools(originalMessage);

    // Strip MCP mentions from text content if any were found
    let processedTextContent = textContent;
    if (mentionedMCPTools.length > 0) {
      processedTextContent = this.stripMCPMentions(textContent);
    }

    // Get chat history
    const memory = this.chainManager.memoryManager.getMemory();
    const memoryVariables = await memory.loadMemoryVariables({});
    const chatHistory = extractChatHistory(memoryVariables);

    // Create messages array starting with system message
    const messages: any[] = [];

    // Add system message if available
    let fullSystemMessage = await this.getSystemPrompt();

    // Add chat history context to system message if exists
    if (chatHistory.length > 0) {
      fullSystemMessage +=
        "\n\nThe following is the relevant conversation history. Use this context to maintain consistency in your responses:";
    }

    // Get chat model for role determination for O-series models
    const chatModel = this.chainManager.chatModelManager.getChatModel();

    // Add the combined system message with appropriate role
    if (fullSystemMessage) {
      messages.push({
        role: getMessageRole(chatModel),
        content: `${fullSystemMessage}\nIMPORTANT: Maintain consistency with previous responses in the conversation. If you've provided information about a person or topic before, use that same information in follow-up questions.`,
      });
    }

    // Add chat history
    for (const entry of chatHistory) {
      messages.push({ role: entry.role, content: entry.content });
    }

    // Get the current chat model
    const chatModelCurrent = this.chainManager.chatModelManager.getChatModel();
    const isMultimodalCurrent = this.isMultimodalModel(chatModelCurrent);

    // Build message content with text and images for multimodal models, or just text for text-only models
    const content = isMultimodalCurrent
      ? await this.buildMessageContent(processedTextContent, userMessage)
      : processedTextContent;

    // Add current user message
    messages.push({
      role: "user",
      content,
    });

    const enhancedUserMessage = content instanceof Array ? (content[0] as any).text : content;
    logInfo("Enhanced user message: ", enhancedUserMessage);

    // Check if we need to bind MCP tools for function calling
    let modelToUse: BaseChatModel | Runnable = chatModelCurrent;
    if (mentionedMCPTools.length > 0) {
      const toolDefinitions = await this.getMCPToolDefinitions(mentionedMCPTools);
      if (toolDefinitions.length > 0) {
        // Bind tools to the model
        try {
          if ("bindTools" in chatModelCurrent && typeof chatModelCurrent.bindTools === "function") {
            modelToUse = chatModelCurrent.bindTools(toolDefinitions);
            logInfo(
              "Bound MCP tools to model:",
              toolDefinitions.map((t: any) => t.name)
            );
          } else {
            console.warn("Model does not support tool binding, using original model");
            modelToUse = chatModelCurrent;
          }
        } catch (error) {
          console.warn("Failed to bind tools to model, falling back to original model:", error);
          // Fall back to original model if binding fails
          modelToUse = chatModelCurrent;
        }
      }
    }

    logInfo("==== Final Request to AI ====\n", messages);

    let fullResponse = "";
    const toolCallsBuffer: any[] = [];
    let hasToolCalls = false;

    // For accumulating partial tool call arguments
    const toolCallAccumulator: Map<number, { name: string; args: string; id?: string }> = new Map();

    // Streaming mode: process chunks as they arrive
    const streamer = new ThinkBlockStreamer(updateCurrentAiMessage);
    const chatStream = await withSuppressedTokenWarnings(() => modelToUse.stream(messages));

    for await (const chunk of chatStream) {
      if (abortController.signal.aborted) break;

      // Handle tool_call_chunks for partial tool call data
      if (chunk.tool_call_chunks && chunk.tool_call_chunks.length > 0) {
        hasToolCalls = true;

        for (const toolChunk of chunk.tool_call_chunks) {
          const index = toolChunk.index;

          if (!toolCallAccumulator.has(index)) {
            toolCallAccumulator.set(index, { name: "", args: "", id: toolChunk.id });
          }

          const accumulator = toolCallAccumulator.get(index)!;

          // Accumulate name if provided
          if (toolChunk.name) {
            accumulator.name = toolChunk.name;
          }

          // Accumulate args (partial JSON)
          if (toolChunk.args) {
            accumulator.args += toolChunk.args;
          }

          // Update ID if provided
          if (toolChunk.id) {
            accumulator.id = toolChunk.id;
          }
        }

        logInfo("Tool call accumulator state:", Array.from(toolCallAccumulator.entries()));
      }

      // Check if this chunk contains complete tool calls (fallback for non-streaming providers)
      // Only process if we don't have tool_call_chunks (which means we're accumulating)
      if (!chunk.tool_call_chunks && chunk.tool_calls && chunk.tool_calls.length > 0) {
        const validToolCalls = chunk.tool_calls.filter(
          (tc: any) => tc.name && tc.name.trim() !== ""
        );
        if (validToolCalls.length > 0) {
          hasToolCalls = true;
          logInfo("Complete tool calls received:", JSON.stringify(validToolCalls));

          for (const toolCall of validToolCalls) {
            toolCallsBuffer.push({
              ...toolCall,
              id:
                toolCall.id || `tool_call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              name: toolCall.name,
              args: toolCall.args || toolCall.input || {},
            });
          }
        }
      }

      // Process chunk content (text, thinking blocks, etc.)
      streamer.processChunk(chunk);
    }

    // After streaming is done, parse accumulated tool calls
    if (hasToolCalls && toolCallAccumulator.size > 0) {
      // Clear the buffer first if we have accumulated tool calls
      // This prevents duplicates from the incomplete tool_calls array
      toolCallsBuffer.length = 0;

      for (const [index, accumulator] of toolCallAccumulator.entries()) {
        if (accumulator.name && accumulator.args) {
          try {
            // Parse the accumulated JSON arguments
            const parsedArgs = JSON.parse(accumulator.args);
            toolCallsBuffer.push({
              id: accumulator.id || `tool_call_${Date.now()}_${index}`,
              name: accumulator.name,
              args: parsedArgs,
            });
            logInfo(`Parsed tool call ${index}:`, { name: accumulator.name, args: parsedArgs });
          } catch (error) {
            logError(
              `Failed to parse tool call arguments for ${accumulator.name}:`,
              accumulator.args,
              error
            );
          }
        }
      }
    }

    fullResponse = streamer.close();

    // If we received tool calls, execute them and continue the conversation
    if (hasToolCalls && toolCallsBuffer.length > 0) {
      logInfo("Executing tools and continuing conversation...");
      logInfo("Tool calls to execute:", toolCallsBuffer);

      // Execute the tools
      const toolResults = await this.executeMCPTools(toolCallsBuffer, mentionedMCPTools);
      console.log("✅ Tool execution results:", toolResults);

      // Add tool calls and results to message history for current conversation
      const assistantWithToolCallsMessage = {
        role: "assistant",
        content: fullResponse,
        tool_calls: toolCallsBuffer,
      };
      messages.push(assistantWithToolCallsMessage);

      // Add tool results to message history
      const toolResultMessages = [];
      for (const result of toolResults) {
        const toolResultMessage = {
          role: "tool",
          content: JSON.stringify(result.output),
          tool_call_id: result.tool_call_id,
          name: result.tool_name,
        };
        messages.push(toolResultMessage);
        toolResultMessages.push(toolResultMessage);
      }

      // Store tool results for later inclusion in memory
      // This will be used by handleResponse to include tool context
      (this as any).lastToolResults = toolResultMessages;

      // Continue conversation with tool results

      // Streaming follow-up
      const streamer = new ThinkBlockStreamer(updateCurrentAiMessage);
      streamer.fullResponse = fullResponse; // Initialize with existing content

      const followUpStream = await withSuppressedTokenWarnings(() => modelToUse.stream(messages));

      for await (const followUpChunk of followUpStream) {
        if (abortController.signal.aborted) break;
        streamer.processChunk(followUpChunk);
      }

      fullResponse = streamer.close();
    }

    return fullResponse;
  }

  async run(
    userMessage: ChatMessage,
    abortController: AbortController,
    updateCurrentAiMessage: (message: string) => void,
    addMessage: (message: ChatMessage) => void,
    options: {
      debug?: boolean;
      ignoreSystemMessage?: boolean;
      updateLoading?: (loading: boolean) => void;
      updateLoadingMessage?: (message: string) => void;
    }
  ): Promise<string> {
    const { debug = false, updateLoadingMessage } = options;
    let fullAIResponse = "";
    let sources: { title: string; score: number }[] = [];

    try {
      // Check if this is a YouTube-only message
      if (this.isYoutubeOnlyMessage(userMessage.message)) {
        const url = extractYoutubeUrl(userMessage.message);
        const failMessage =
          "Transcript not available. Only videos with the auto transcript option turned on are supported at the moment.";
        if (url) {
          try {
            const response = await BrevilabsClient.getInstance().youtube4llm(url);
            if (response.response.transcript) {
              return this.handleResponse(
                response.response.transcript,
                userMessage,
                abortController,
                addMessage,
                updateCurrentAiMessage,
                debug
              );
            }
            return this.handleResponse(
              failMessage,
              userMessage,
              abortController,
              addMessage,
              updateCurrentAiMessage,
              debug
            );
          } catch (error) {
            console.error("Error processing YouTube video:", error);
            return this.handleResponse(
              failMessage,
              userMessage,
              abortController,
              addMessage,
              updateCurrentAiMessage,
              debug
            );
          }
        }
      }

      if (debug) console.log("==== Step 1: Analyzing intent ====");
      let toolCalls;
      // Use the original message for intent analysis
      const messageForAnalysis = userMessage.originalMessage || userMessage.message;
      try {
        toolCalls = await IntentAnalyzer.analyzeIntent(messageForAnalysis);
      } catch (error: any) {
        return this.handleResponse(
          getApiErrorMessage(error),
          userMessage,
          abortController,
          addMessage,
          updateCurrentAiMessage,
          debug
        );
      }

      // Use the same removeAtCommands logic as IntentAnalyzer
      const cleanedUserMessage = userMessage.message
        .split(" ")
        .filter((word) => !COPILOT_TOOL_NAMES.includes(word.toLowerCase()))
        .join(" ")
        .trim();

      const toolOutputs = await this.executeToolCalls(toolCalls, debug, updateLoadingMessage);
      const localSearchResult = toolOutputs.find(
        (output) => output.tool === "localSearch" && output.output && output.output.length > 0
      );

      // Format chat history from memory
      const memory = this.chainManager.memoryManager.getMemory();
      const memoryVariables = await memory.loadMemoryVariables({});
      const chatHistory = extractChatHistory(memoryVariables);

      if (localSearchResult) {
        if (debug) console.log("==== Step 2: Processing local search results ====");
        const documents = JSON.parse(localSearchResult.output);

        if (debug) console.log("==== Step 3: Condensing Question ====");
        const standaloneQuestion = await getStandaloneQuestion(cleanedUserMessage, chatHistory);
        if (debug) console.log("Condensed standalone question: ", standaloneQuestion);

        if (debug) console.log("==== Step 4: Preparing context ====");
        const timeExpression = this.getTimeExpression(toolCalls);
        const context = this.prepareLocalSearchResult(documents, timeExpression);

        const currentTimeOutputs = toolOutputs.filter((output) => output.tool === "getCurrentTime");
        const enhancedQuestion = this.prepareEnhancedUserMessage(
          standaloneQuestion,
          currentTimeOutputs
        );

        if (debug) console.log(context);
        if (debug) console.log("==== Step 5: Invoking QA Chain ====");
        const qaPrompt = await this.chainManager.promptManager.getQAPrompt({
          question: enhancedQuestion,
          context,
          systemMessage: "", // System prompt is added separately in streamMultimodalResponse
        });

        fullAIResponse = await this.streamMultimodalResponse(
          qaPrompt,
          userMessage,
          abortController,
          updateCurrentAiMessage,
          debug
        );

        // Append sources to the response
        sources = this.getSources(documents);
      } else {
        // Enhance with tool outputs.
        const enhancedUserMessage = this.prepareEnhancedUserMessage(
          cleanedUserMessage,
          toolOutputs
        );
        // If no results, default to LLM Chain
        logInfo("No local search results. Using standard LLM Chain.");

        fullAIResponse = await this.streamMultimodalResponse(
          enhancedUserMessage,
          userMessage,
          abortController,
          updateCurrentAiMessage,
          debug
        );
      }
    } catch (error) {
      // Reset loading message to default
      updateLoadingMessage?.(LOADING_MESSAGES.DEFAULT);
      await this.handleError(error, debug, addMessage, updateCurrentAiMessage);
    }

    return this.handleResponse(
      fullAIResponse,
      userMessage,
      abortController,
      addMessage,
      updateCurrentAiMessage,
      debug,
      sources
    );
  }

  private getSources(documents: any): { title: string; score: number }[] {
    if (!documents || !Array.isArray(documents)) {
      console.warn("No valid documents provided to getSources");
      return [];
    }
    return this.sortUniqueDocsByScore(documents);
  }

  private sortUniqueDocsByScore(documents: any[]): any[] {
    const uniqueDocs = new Map<string, any>();

    // Iterate through all documents
    for (const doc of documents) {
      if (!doc.title || (!doc?.score && !doc?.rerank_score)) {
        console.warn("Invalid document structure:", doc);
        continue;
      }

      const currentDoc = uniqueDocs.get(doc.title);
      const isReranked = doc && "rerank_score" in doc;
      const docScore = isReranked ? doc.rerank_score : doc.score;

      // If the title doesn't exist in the map, or if the new doc has a higher score, update the map
      if (!currentDoc || docScore > (currentDoc.score ?? 0)) {
        uniqueDocs.set(doc.title, {
          title: doc.title,
          score: docScore,
          isReranked: isReranked,
        });
      }
    }

    // Convert the map values back to an array and sort by score in descending order
    return Array.from(uniqueDocs.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  private async executeToolCalls(
    toolCalls: any[],
    debug: boolean,
    updateLoadingMessage?: (message: string) => void
  ) {
    const toolOutputs = [];
    for (const toolCall of toolCalls) {
      if (debug) {
        console.log(`==== Step 2: Calling tool: ${toolCall.tool.name} ====`);
      }
      if (toolCall.tool.name === "localSearch") {
        updateLoadingMessage?.(LOADING_MESSAGES.READING_FILES);
      } else if (toolCall.tool.name === "webSearch") {
        updateLoadingMessage?.(LOADING_MESSAGES.SEARCHING_WEB);
      } else if (toolCall.tool.name === "getFileTree") {
        updateLoadingMessage?.(LOADING_MESSAGES.READING_FILE_TREE);
      }
      const output = await ToolManager.callTool(toolCall.tool, toolCall.args);
      toolOutputs.push({ tool: toolCall.tool.name, output });
    }
    return toolOutputs;
  }

  private prepareEnhancedUserMessage(userMessage: string, toolOutputs: any[]) {
    let context = "";
    if (toolOutputs.length > 0) {
      const validOutputs = toolOutputs.filter((output) => output.output != null);
      if (validOutputs.length > 0) {
        context =
          "\n\n# Additional context:\n\n" +
          validOutputs
            .map(
              (output) =>
                `<${output.tool}>\n${typeof output.output !== "string" ? JSON.stringify(output.output) : output.output}\n</${output.tool}>`
            )
            .join("\n\n");
      }
    }
    return `${userMessage}${context}`;
  }

  private getTimeExpression(toolCalls: any[]): string {
    const timeRangeCall = toolCalls.find((call) => call.tool.name === "getTimeRangeMs");
    return timeRangeCall ? timeRangeCall.args.timeExpression : "";
  }

  private prepareLocalSearchResult(documents: any[], timeExpression: string): string {
    // First filter documents with includeInContext
    const includedDocs = documents.filter((doc) => doc.includeInContext);

    // Calculate total content length
    const totalLength = includedDocs.reduce((sum, doc) => sum + doc.content.length, 0);

    // If total length exceeds threshold, calculate truncation ratio
    let truncatedDocs = includedDocs;
    if (totalLength > MAX_CHARS_FOR_LOCAL_SEARCH_CONTEXT) {
      const truncationRatio = MAX_CHARS_FOR_LOCAL_SEARCH_CONTEXT / totalLength;
      console.log("Truncating documents to fit context length. Truncation ratio:", truncationRatio);
      truncatedDocs = includedDocs.map((doc) => ({
        ...doc,
        content: doc.content.slice(0, Math.floor(doc.content.length * truncationRatio)),
      }));
    }

    const formattedDocs = truncatedDocs
      .map((doc: any) => `Note in Vault: ${doc.content}`)
      .join("\n\n");

    return timeExpression
      ? `Local Search Result for ${timeExpression}:\n${formattedDocs}`
      : `Local Search Result:\n${formattedDocs}`;
  }

  protected async getSystemPrompt(): Promise<string> {
    return getSystemPrompt();
  }
}

/**
 * Handles Pirate mode requests without using the Broca API. When the
 * user includes `@vault` in the message it performs a retrieval style
 * QA request, otherwise it behaves like a normal chat interaction that
 * supports multimodal input. Sources are appended when available.
 */
class PirateChainRunner extends CopilotPlusChainRunner {
  async run(
    userMessage: ChatMessage,
    abortController: AbortController,
    updateCurrentAiMessage: (message: string) => void,
    addMessage: (message: ChatMessage) => void,
    options: {
      debug?: boolean;
      ignoreSystemMessage?: boolean;
      updateLoading?: (loading: boolean) => void;
      updateLoadingMessage?: (message: string) => void;
    }
  ): Promise<string> {
    const { debug = false } = options;
    let fullAIResponse = "";

    try {
      const includesVault = userMessage.originalMessage?.includes("@vault") ?? false;
      const cleanedMessage = userMessage.message.replace("@vault", "").trim();

      if (includesVault) {
        const indexEmpty = await this.chainManager.vectorStoreManager.isIndexEmpty();
        if (indexEmpty) {
          return this.handleResponse(
            EMPTY_INDEX_ERROR_MESSAGE,
            userMessage,
            abortController,
            addMessage,
            updateCurrentAiMessage,
            debug
          );
        }

        const memory = this.chainManager.memoryManager.getMemory();
        const memoryVariables = await memory.loadMemoryVariables({});
        const chatHistory = extractChatHistory(memoryVariables);
        const qaStream = await this.chainManager.getRetrievalChain().stream({
          question: cleanedMessage,
          chat_history: chatHistory,
        } as any);

        for await (const chunk of qaStream) {
          if (abortController.signal.aborted) break;
          fullAIResponse += chunk.content;
          updateCurrentAiMessage(fullAIResponse);
        }

        fullAIResponse = this.addSourcestoResponse(fullAIResponse);
      } else {
        fullAIResponse = await this.streamMultimodalResponse(
          cleanedMessage,
          userMessage,
          abortController,
          updateCurrentAiMessage,
          debug
        );
      }
    } catch (error) {
      await this.handleError(error, debug, addMessage, updateCurrentAiMessage);
    }

    return this.handleResponse(
      fullAIResponse,
      userMessage,
      abortController,
      addMessage,
      updateCurrentAiMessage,
      debug
    );
  }

  private addSourcestoResponse(response: string): string {
    const docTitles = extractUniqueTitlesFromDocs(this.chainManager.getRetrievedDocuments());
    if (docTitles.length > 0) {
      const links = docTitles.map((title) => `- [[${title}]]`).join("\n");
      response += "\n\n#### Sources:\n\n" + links;
    }
    return response;
  }
}

class ProjectChainRunner extends CopilotPlusChainRunner {
  protected async getSystemPrompt(): Promise<string> {
    let finalPrompt = getSystemPrompt();
    const projectConfig = getCurrentProject();
    if (!projectConfig) {
      return finalPrompt;
    }

    // Get context asynchronously
    const context = await ProjectManager.instance.getProjectContext(projectConfig.id);
    finalPrompt = `${finalPrompt}\n\n<project_system_prompt>\n${projectConfig.systemPrompt}\n</project_system_prompt>`;

    // TODO: Move project context out of the system prompt and into the user prompt.
    if (context) {
      finalPrompt = `${finalPrompt}\n\n <project_context>\n${context}\n</project_context>`;
    }

    return finalPrompt;
  }
}

export {
  CopilotPlusChainRunner,
  PirateChainRunner,
  LLMChainRunner,
  ProjectChainRunner,
  VaultQAChainRunner,
};
