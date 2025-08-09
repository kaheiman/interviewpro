// ProcessingHelper.ts
import fs from "node:fs"
import path from "node:path"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { IProcessingHelperDeps } from "./main"
import * as axios from "axios"
import { app, BrowserWindow, dialog } from "electron"
import { OpenAI } from "openai"
import { configHelper } from "./ConfigHelper"
import { ProblemInfo, CodeInfo } from "../src/types/index.js"

// Interface for Gemini API requests
interface GeminiMessage {
  role: string;
  parts: Array<{
    text?: string;
    inlineData?: {
      mimeType: string;
      data: string;
    }
  }>;
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
    };
    finishReason: string;
  }>;
}

export class ProcessingHelper {
  private deps: IProcessingHelperDeps
  private screenshotHelper: ScreenshotHelper
  private openaiClient: OpenAI | null = null
  private geminiApiKey: string | null = null

  // AbortControllers for API requests
  private currentProcessingAbortController: AbortController | null = null
  private currentExtraProcessingAbortController: AbortController | null = null

  constructor(deps: IProcessingHelperDeps) {
    this.deps = deps
    this.screenshotHelper = deps.getScreenshotHelper()
    
    // Initialize AI client based on config
    this.initializeAIClient();
    
    // Listen for config changes to re-initialize the AI client
    configHelper.on('config-updated', () => {
      this.initializeAIClient();
    });
  }
  
  /**
   * Initialize or reinitialize the AI client with current config
   */
  private initializeAIClient(): void {
    try {
      const config = configHelper.loadConfig();
      
      if (config.apiProvider === "openai") {
        if (config.apiKey) {
          this.openaiClient = new OpenAI({ 
            apiKey: config.apiKey,
            timeout: 60000, // 60 second timeout
            maxRetries: 2   // Retry up to 2 times
          });
          this.geminiApiKey = null;
          console.log("OpenAI client initialized successfully");
        } else {
          this.openaiClient = null;
          this.geminiApiKey = null;
          console.warn("No API key available, OpenAI client not initialized");
        }
      } else {
        // Gemini client initialization
        this.openaiClient = null;
        if (config.apiKey) {
          this.geminiApiKey = config.apiKey;
          console.log("Gemini API key set successfully");
        } else {
          this.geminiApiKey = null;
          console.warn("No API key available, Gemini client not initialized");
        }
      }
    } catch (error) {
      console.error("Failed to initialize AI client:", error);
      this.openaiClient = null;
      this.geminiApiKey = null;
    }
  }

  private async waitForInitialization(
    mainWindow: BrowserWindow
  ): Promise<void> {
    let attempts = 0
    const maxAttempts = 50 // 5 seconds total

    while (attempts < maxAttempts) {
      const isInitialized = await mainWindow.webContents.executeJavaScript(
        "window.__IS_INITIALIZED__"
      )
      if (isInitialized) return
      await new Promise((resolve) => setTimeout(resolve, 100))
      attempts++
    }
    throw new Error("App failed to initialize after 5 seconds")
  }

  private async getCredits(): Promise<number> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return 999 // Unlimited credits in this version

    try {
      await this.waitForInitialization(mainWindow)
      return 999 // Always return sufficient credits to work
    } catch (error) {
      console.error("Error getting credits:", error)
      return 999 // Unlimited credits as fallback
    }
  }

  private async getInterviewMode(): Promise<string> {
    const config = configHelper.loadConfig();
    if (config.interviewMode) {
      return config.interviewMode;
    }

    const mainWindow = this.deps.getMainWindow()
    console.log('mainWindow:', mainWindow)
    if (!mainWindow) return "Coding"

    try {
      await this.waitForInitialization(mainWindow)
      const mode = await mainWindow.webContents.executeJavaScript(
        "window.__INTERVIEW_MODE__"
      )
      if (mode !== undefined && mode !== null) return mode
      return "Coding"
    } catch (error) {
      console.error("Error getting interview mode:", error)
      return "Coding"
    }
  }

  private async getLanguage(): Promise<string> {
    try {
      // Get language from config
      const config = configHelper.loadConfig();
      if (config.language) {
        return config.language;
      }
      
      // Fallback to window variable if config doesn't have language
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        try {
          await this.waitForInitialization(mainWindow)
          const language = await mainWindow.webContents.executeJavaScript(
            "window.__LANGUAGE__"
          )

          if (
            typeof language === "string" &&
            language !== undefined &&
            language !== null
          ) {
            return language;
          }
        } catch (err) {
          console.warn("Could not get language from window", err);
        }
      }
      
      // Default fallback
      return "python";
    } catch (error) {
      console.error("Error getting language:", error)
      return "python"
    }
  }

  public async processScreenshots(): Promise<void> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return

    const config = configHelper.loadConfig();
    
    // First verify we have a valid AI client
    if (config.apiProvider === "openai" && !this.openaiClient) {
      this.initializeAIClient();
      
      if (!this.openaiClient) {
        console.error("OpenAI client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    } else if (config.apiProvider === "gemini" && !this.geminiApiKey) {
      this.initializeAIClient();
      
      if (!this.geminiApiKey) {
        console.error("Gemini API key not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    }

    const view = this.deps.getView()
    console.log("Processing screenshots in view:", view)

    if (view === "queue") {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START)
      const screenshotQueue = this.screenshotHelper.getScreenshotQueue()
      console.log("Processing main queue screenshots:", screenshotQueue)
      
      // Check if the queue is empty
      if (!screenshotQueue || screenshotQueue.length === 0) {
        console.log("No screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        
        // Show dialog if no screenshots
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'No Screenshots Detected',
          message: 'No screenshots were found to process.',
          detail: 'Please take a screenshot first using Ctrl+H (or Cmd+H on Mac). Make sure your screenshot contains the coding problem you want to solve.',
          buttons: ['OK']
        });
        return;
      }

      // Check that files actually exist
      const existingScreenshots = screenshotQueue.filter(path => fs.existsSync(path));
      if (existingScreenshots.length === 0) {
        console.log("Screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        
        // Show error dialog
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Screenshot Files Missing',
          message: 'The screenshot files were not found on disk.',
          detail: 'Try taking a new screenshot with Ctrl+H (or Cmd+H on Mac).',
          buttons: ['OK']
        });
        return;
      }

      try {
        // Initialize AbortController
        this.currentProcessingAbortController = new AbortController()
        const { signal } = this.currentProcessingAbortController

        const screenshots = await Promise.all(
          existingScreenshots.map(async (path) => {
            try {
              return {
                path,
                preview: await this.screenshotHelper.getImagePreview(path),
                data: fs.readFileSync(path).toString('base64')
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          })
        )

        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(Boolean);
        
        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data");
        }

        // move to try catch block
        const interviewMode = await this.getInterviewMode()
        if (interviewMode === "SystemDesign") {
          console.log("System Design mode detected, skipping screenshot processing")
          const systemDesignResultData = await this.processSystemDesignScreenshot(validScreenshots, signal);

          console.log("System Design AI result data:", systemDesignResultData)

          if (!systemDesignResultData.success) {
            console.log("Processing system design data failed:", systemDesignResultData.error)
            if (systemDesignResultData.error?.includes("API Key") || systemDesignResultData.error?.includes("OpenAI") || systemDesignResultData.error?.includes("Gemini")) {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.API_KEY_INVALID
              )
            } else {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
                systemDesignResultData.error
              )
            }
            // Reset view back to queue on error
            console.log("Resetting view to queue due to error")
            this.deps.setView("queue")
            return            
          }

          // must require INITIAL_START and processing-status
          mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START)
          mainWindow.webContents.send("processing-status", {
            message: "Problem analyzed successfully. Preparing to generate solution...",
            progress: 40
          });

          this.screenshotHelper.clearExtraScreenshotQueue();
          this.deps.setView("solutions")

          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            systemDesignResultData.data
          );
          return
        }
        
        if (interviewMode === "Bugfix") {
          console.log("Bugfix mode detected, processing for debugging")
          const bugfixResultData = await this.processBugfixScreenshot(validScreenshots, signal);

          console.log("Bugfix AI result data:", bugfixResultData)

          if (!bugfixResultData.success) {
            console.log("Processing bugfix data failed:", bugfixResultData.error)
            if (bugfixResultData.error?.includes("API Key") || bugfixResultData.error?.includes("OpenAI") || bugfixResultData.error?.includes("Gemini")) {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.API_KEY_INVALID
              )
            } else {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
                bugfixResultData.error
              )
            }
            // Reset view back to queue on error
            console.log("Resetting view to queue due to error")
            this.deps.setView("queue")
            return            
          }

          // must require INITIAL_START and processing-status
          mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START)
          mainWindow.webContents.send("processing-status", {
            message: "Bug analysis complete. Preparing to generate fix...",
            progress: 40
          });

          this.screenshotHelper.clearExtraScreenshotQueue();
          this.deps.setView("solutions")

          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            bugfixResultData.data
          );
          return
        }        
        const result = await this.processScreenshotsHelper(validScreenshots, signal)

        if (!result.success) {
          console.log("Processing failed:", result.error)
          if (result.error?.includes("API Key") || result.error?.includes("OpenAI") || result.error?.includes("Gemini")) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.API_KEY_INVALID
            )
          } else {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
              result.error
            )
          }
          // Reset view back to queue on error
          console.log("Resetting view to queue due to error")
          this.deps.setView("queue")
          return
        }

        // Only set view to solutions if processing succeeded
        console.log("Setting view to solutions after successful processing")
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
          result.data
        )
        this.deps.setView("solutions")
      } catch (error: any) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
          error
        )
        console.error("Processing error:", error)
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            "Processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            error.message || "Server error. Please try again."
          )
        }
        // Reset view back to queue on error
        console.log("Resetting view to queue due to error")
        this.deps.setView("queue")
      } finally {
        this.currentProcessingAbortController = null
      }
    } else {
      // view == 'solutions'
      const extraScreenshotQueue =
        this.screenshotHelper.getExtraScreenshotQueue()
      console.log("Processing extra queue screenshots:", extraScreenshotQueue)
      
      // Check if the extra queue is empty
      if (!extraScreenshotQueue || extraScreenshotQueue.length === 0) {
        console.log("No extra screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        
        // Show dialog if no screenshots
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'No Debug Screenshots',
          message: 'No screenshots were found for debugging.',
          detail: 'Please take screenshots of your code/errors with Ctrl+H before debugging.',
          buttons: ['OK']
        });
        return;
      }

      // Check that files actually exist
      const existingExtraScreenshots = extraScreenshotQueue.filter(path => fs.existsSync(path));
      if (existingExtraScreenshots.length === 0) {
        console.log("Extra screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Screenshot Files Missing',
          message: 'The debug screenshot files were not found.',
          detail: 'Try taking a new screenshot with Ctrl+H (or Cmd+H on Mac).',
          buttons: ['OK']
        });
        return;
      }
      
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.DEBUG_START)

      // Initialize AbortController
      this.currentExtraProcessingAbortController = new AbortController()
      const { signal } = this.currentExtraProcessingAbortController

      try {
        // Get all screenshots (both main and extra) for processing
        const allPaths = [
          ...this.screenshotHelper.getScreenshotQueue(),
          ...existingExtraScreenshots
        ];
        
        const screenshots = await Promise.all(
          allPaths.map(async (path) => {
            try {
              if (!fs.existsSync(path)) {
                console.warn(`Screenshot file does not exist: ${path}`);
                return null;
              }
              
              return {
                path,
                preview: await this.screenshotHelper.getImagePreview(path),
                data: fs.readFileSync(path).toString('base64')
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          })
        )
        
        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(Boolean);
        
        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data for debugging");
        }
        
        console.log(
          "Combined screenshots for processing:",
          validScreenshots.map((s) => s.path)
        )

        const result = await this.processExtraScreenshotsHelper(
          validScreenshots,
          signal
        )

        if (result.success) {
          this.deps.setHasDebugged(true)
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_SUCCESS,
            result.data
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            result.error
          )
        }
      } catch (error: any) {
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            "Extra processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            error.message
          )
        }
      } finally {
        this.currentExtraProcessingAbortController = null
      }
    }
  }

  private async processScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal
  ) {
    try {
      const config = configHelper.loadConfig();
      const language = await this.getLanguage();
      const mainWindow = this.deps.getMainWindow();
      
      // Step 1: Extract problem info using AI Vision API (OpenAI or Gemini)
      const imageDataList = screenshots.map(screenshot => screenshot.data);
      
      // Update the user on progress
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Analyzing problem from screenshots...",
          progress: 20
        });
      }

      let problemInfo;
      
      if (config.apiProvider === "openai") {
        // Verify OpenAI client
        if (!this.openaiClient) {
          this.initializeAIClient(); // Try to reinitialize
          
          if (!this.openaiClient) {
            return {
              success: false,
              error: "OpenAI API key not configured or invalid. Please check your settings."
            };
          }
        }

        // Use OpenAI for processing
        const messages = [
          {
            role: "system" as const, 
            content: "You are a coding challenge interpreter. Analyze the screenshot of the coding problem and extract all relevant information. Return the information in JSON format with these fields: problem_statement, constraints, example_input, example_output. Just return the structured JSON without any other text."
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const, 
                text: `Extract the coding problem details from these screenshots. Return in JSON format. Preferred coding language we gonna use for this problem is ${language}.`
              },
              ...imageDataList.map(data => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` }
              }))
            ]
          }
        ];

        // Send to OpenAI Vision API
        const extractionResponse = await this.openaiClient.chat.completions.create({
          model: config.extractionModel || "gpt-4o",
          messages: messages,
          max_tokens: 4000,
          temperature: 0.2
        });

        // Parse the response
        try {
          const responseText = extractionResponse.choices[0].message.content;
          // Handle when OpenAI might wrap the JSON in markdown code blocks
          const jsonText = responseText.replace(/```json|```/g, '').trim();
          problemInfo = JSON.parse(jsonText);
        } catch (error) {
          console.error("Error parsing OpenAI response:", error);
          return {
            success: false,
            error: "Failed to parse problem information. Please try again or use clearer screenshots."
          };
        }
      } else {
        // Use Gemini API
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }

        try {
          // Create Gemini message structure
          const geminiMessages: GeminiMessage[] = [
            {
              role: "user",
              parts: [
                {
                  text: `You are a coding challenge interpreter. Analyze the screenshots of the coding problem and extract all relevant information. Return the information in JSON format with these fields: problem_statement, constraints, example_input, example_output. Just return the structured JSON without any other text. Preferred coding language we gonna use for this problem is ${language}.`
                },
                ...imageDataList.map(data => ({
                  inlineData: {
                    mimeType: "image/png",
                    data: data
                  }
                }))
              ]
            }
          ];

          // Make API request to Gemini
          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.extractionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;
          
          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }
          
          const responseText = responseData.candidates[0].content.parts[0].text;
          
          // Handle when Gemini might wrap the JSON in markdown code blocks
          const jsonText = responseText.replace(/```json|```/g, '').trim();
          problemInfo = JSON.parse(jsonText);
        } catch (error) {
          console.error("Error using Gemini API:", error);
          return {
            success: false,
            error: "Failed to process with Gemini API. Please check your API key or try again later."
          };
        }
      }
      
      // Update the user on progress
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Problem analyzed successfully. Preparing to generate solution...",
          progress: 40
        });
      }

      // Store problem info in AppState
      this.deps.setProblemInfo(problemInfo);

      // Send first success event
      if (mainWindow) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.PROBLEM_EXTRACTED,
          problemInfo
        );

        // Generate solutions after successful extraction
        const solutionsResult = await this.generateSolutionsHelper(signal);
        if (solutionsResult.success) {
          // Clear any existing extra screenshots before transitioning to solutions view
          this.screenshotHelper.clearExtraScreenshotQueue();
          
          // Final progress update
          mainWindow.webContents.send("processing-status", {
            message: "Solution generated successfully",
            progress: 100
          });
          
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            solutionsResult.data
          );
          return { success: true, data: solutionsResult.data };
        } else {
          throw new Error(
            solutionsResult.error || "Failed to generate solutions"
          );
        }
      }

      return { success: false, error: "Failed to process screenshots" };
    } catch (error: any) {
      // If the request was cancelled, don't retry
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }
      
      // Handle OpenAI API errors specifically
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid OpenAI API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "OpenAI API rate limit exceeded or insufficient credits. Please try again later."
        };
      } else if (error?.response?.status === 500) {
        return {
          success: false,
          error: "OpenAI server error. Please try again later."
        };
      }

      console.error("API Error Details:", error);
      return { 
        success: false, 
        error: error.message || "Failed to process screenshots. Please try again." 
      };
    }
  }

  private async generateSolutionsHelper(signal: AbortSignal) {
    try {
      const problemInfo = this.deps.getProblemInfo();
      const language = await this.getLanguage();
      const config = configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();

      if (!problemInfo) {
        throw new Error("No problem info available");
      }

      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Creating optimal solution with detailed explanations...",
          progress: 60
        });
      }

      // Create prompt for solution generation
      const promptText = `
Generate a detailed solution for the following coding problem:

PROBLEM STATEMENT:
${problemInfo.problem_statement}

CONSTRAINTS:
${problemInfo.constraints || "No specific constraints provided."}

EXAMPLE INPUT:
${problemInfo.example_input || "No example input provided."}

EXAMPLE OUTPUT:
${problemInfo.example_output || "No example output provided."}

LANGUAGE: ${language}

I need the response in the following format:
1. Code: A clean, optimized implementation in ${language}
2. Your Thoughts: A list of key insights and reasoning behind your approach
3. Time complexity: O(X) with a detailed explanation (at least 2 sentences)
4. Space complexity: O(X) with a detailed explanation (at least 2 sentences)

For complexity explanations, please be thorough. For example: "Time complexity: O(n) because we iterate through the array only once. This is optimal as we need to examine each element at least once to find the solution." or "Space complexity: O(n) because in the worst case, we store all elements in the hashmap. The additional space scales linearly with the input size."

Your solution should be efficient, well-commented, and handle edge cases.
`;

      let responseContent;
      
      if (config.apiProvider === "openai") {
        // OpenAI processing
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings."
          };
        }
        
        // Send to OpenAI API
        const solutionResponse = await this.openaiClient.chat.completions.create({
          model: config.solutionModel || "gpt-4o",
          messages: [
            { role: "system", content: "You are an expert coding interview assistant. Provide clear, optimal solutions with detailed explanations." },
            { role: "user", content: promptText }
          ],
          max_tokens: 4000,
          temperature: 0.2
        });

        responseContent = solutionResponse.choices[0].message.content;
      } else {
        // Gemini processing
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }
        
        try {
          // Create Gemini message structure
          const geminiMessages = [
            {
              role: "user",
              parts: [
                {
                  text: `You are an expert coding interview assistant. Provide a clear, optimal solution with detailed explanations for this problem:\n\n${promptText}`
                }
              ]
            }
          ];

          // Make API request to Gemini
          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.solutionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;
          
          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }
          
          responseContent = responseData.candidates[0].content.parts[0].text;
        } catch (error) {
          console.error("Error using Gemini API for solution:", error);
          return {
            success: false,
            error: "Failed to generate solution with Gemini API. Please check your API key or try again later."
          };
        }
      }
      
      // Extract parts from the response
      const codeMatch = responseContent.match(/```(?:\w+)?\s*([\s\S]*?)```/);
      const code = codeMatch ? codeMatch[1].trim() : responseContent;
      
      // Extract thoughts, looking for bullet points or numbered lists
      const thoughtsRegex = /(?:Thoughts:|Key Insights:|Reasoning:|Approach:)([\s\S]*?)(?:Time complexity:|$)/i;
      const thoughtsMatch = responseContent.match(thoughtsRegex);
      let thoughts: string[] = [];
      
      if (thoughtsMatch && thoughtsMatch[1]) {
        // Extract bullet points or numbered items
        const bulletPoints = thoughtsMatch[1].match(/(?:^|\n)\s*(?:[-*•]|\d+\.)\s*(.*)/g);
        if (bulletPoints) {
          thoughts = bulletPoints.map(point => 
            point.replace(/^\s*(?:[-*•]|\d+\.)\s*/, '').trim()
          ).filter(Boolean);
        } else {
          // If no bullet points found, split by newlines and filter empty lines
          thoughts = thoughtsMatch[1].split('\n')
            .map(line => line.trim())
            .filter(Boolean);
        }
      }
      
      // Extract complexity information
      const timeComplexityPattern = /Time complexity:?\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\s*(?:Space complexity|$))/i;
      const spaceComplexityPattern = /Space complexity:?\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\s*(?:[A-Z]|$))/i;
      
      let timeComplexity = "O(n) - Linear time complexity because we only iterate through the array once. Each element is processed exactly one time, and the hashmap lookups are O(1) operations.";
      let spaceComplexity = "O(n) - Linear space complexity because we store elements in the hashmap. In the worst case, we might need to store all elements before finding the solution pair.";
      
      const timeMatch = responseContent.match(timeComplexityPattern);
      if (timeMatch && timeMatch[1]) {
        timeComplexity = timeMatch[1].trim();
        if (!timeComplexity.match(/O\([^)]+\)/i)) {
          timeComplexity = `O(n) - ${timeComplexity}`;
        } else if (!timeComplexity.includes('-') && !timeComplexity.includes('because')) {
          const notationMatch = timeComplexity.match(/O\([^)]+\)/i);
          if (notationMatch) {
            const notation = notationMatch[0];
            const rest = timeComplexity.replace(notation, '').trim();
            timeComplexity = `${notation} - ${rest}`;
          }
        }
      }
      
      const spaceMatch = responseContent.match(spaceComplexityPattern);
      if (spaceMatch && spaceMatch[1]) {
        spaceComplexity = spaceMatch[1].trim();
        if (!spaceComplexity.match(/O\([^)]+\)/i)) {
          spaceComplexity = `O(n) - ${spaceComplexity}`;
        } else if (!spaceComplexity.includes('-') && !spaceComplexity.includes('because')) {
          const notationMatch = spaceComplexity.match(/O\([^)]+\)/i);
          if (notationMatch) {
            const notation = notationMatch[0];
            const rest = spaceComplexity.replace(notation, '').trim();
            spaceComplexity = `${notation} - ${rest}`;
          }
        }
      }

      const formattedResponse = {
        code: code,
        thoughts: thoughts.length > 0 ? thoughts : ["Solution approach based on efficiency and readability"],
        time_complexity: timeComplexity,
        space_complexity: spaceComplexity
      };

      return { success: true, data: formattedResponse };
    } catch (error: any) {
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }
      
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid OpenAI API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "OpenAI API rate limit exceeded or insufficient credits. Please try again later."
        };
      }
      
      console.error("Solution generation error:", error);
      return { success: false, error: error.message || "Failed to generate solution" };
    }
  }

  private async processSystemDesignScreenshot(screenshots: Array<{ path: string; data: string }>, signal: AbortSignal) {
    try {
      const config = configHelper.loadConfig();
      // Create prompt for solution generation
      const promptText = `
As a Principal Engineer in large scale tech driven companies like google, you are participating in a system design discussion. 
You're expected to evaluate tradeoffs, define system boundaries, APIs, scale characteristics, and clarify ambiguous areas with product and engineering peers.
Bonus to use technical domain keywords

PROBLEM STATEMENT: BASED ON THE SCREENSHOT YOU SEE, GENERATE A PROBLEM STATEMENT

Generate a high-level system architecture diagram in code format compatible with React Flow. The output should be a JavaScript object with two arrays:
{ nodes: Node[], edges: Edge[] }
* Each item in the nodes array should represent a core component of the system.
* Each item in the edges array should represent a connection or transition between components, with an optional label to describe the action or data flow.
* Each node should have:
    * id (string, unique), the entry point should be 1, and the id can use index + 1
    * data.label (name of the component),
    * position: { x: number, y: number } (can be { x: 0, y: 0 } for layout later)
* Each edge should have:
    * id (e.g., e1-2), where 1 is the source node id and 2 is target node id
    * source and target (match node ids),
    * Optional label to describe the interaction.
Example structure:
const nodes = [
  { id: '1', data: { label: 'API Gateway' }, position: { x: 0, y: 0 } },
  { id: '2', data: { label: 'Auth Service' }, position: { x: 0, y: 0 } },
];

const edges = [
  { id: 'e1-2', source: '1', target: '2', label: 'Authenticate Request' },
];

Please output the complete { nodes, edges } object in this format, based on the system

{
  "problem_statement": "string", // based on the screenshot, analyze what is the problem statement
  "description": "string",     // it is a paraphrase of your understanding on the problem, eg: what a "VirusTotal-like" system is
  "clarifications": [ { "questions", "string", "reason": "string" }], // list 3-4 high quality questions you want to get more clarification from your peers and the reason behind
  "functional_requirements": [ { api_interface, "workflow": string, "use_case": "string"} ], // list 3 core use cases, each use case is a workflow how the system being interact, also digest the workflow into api interface with request and response looks like
  "non_functional_requirements": {
    "traffic": "string",
    "storage": "string",
    "latency": "string",
    "optimization_in_quality": "string"
  } // estimate the number in traffic (any spike), storage size (how you calculate it), latency (SLO), what quality you want to focus optimize in this discussion and any tradeoff achieving this quality
  "component_dive_deep": [ { alternative, reason, tradeoff, component } ], // based on the solution pick 3 components to talk about the tradeoff with alternative solution and reason. Focus on database to use, event driven or not, Redis or not
  "open_questions": "string" // any questions you think critical to bring up the table that others may overlook
  "nodes": [], //  architecture diagram components node
  "edges": [],  // architecture diagram transition edges
  "steps_walkthrough": [] // Provide a detailed, step-by-step breakdown of how the system works, explaining the flow of data and responsibilities of each component, each step should match the node and transition edge,
  "database_schema": [json] // Database schema in array of json format, the json format should be same as below
    interface ColumnSchema {
      [columnName: string]: string | undefined; // with what is the type of the column and what is it used for
    }
    
    interface TableSchema {
      table: string;
      columns: ColumnSchema;
      constraints: string[];
    }
}

Only return 
1. this JSON structure with thoughtful, realistic content. 

Do not include any additional explanation.
`;

      let responseContent;
      
      if (config.apiProvider === "openai") {
        // OpenAI processing
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings."
          };
        }
        
        // Send to OpenAI API
        const solutionResponse = await this.openaiClient.chat.completions.create({
          model: config.solutionModel || "gpt-4o",
          messages: [
            { role: "system", content: "You are an expert system design interview assistant.  Analyze the screenshot of the system design problem and extract the information in JSON format based on user requirements" },
            { role: "user", 
              content: [{
                type: "text" as const, 
                text: promptText
              },
              ...screenshots.map(data => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data.data}` }
              }))
            ]}
          ],
          max_tokens: 7000,
          temperature: 0.2
        });

        const responseText = solutionResponse.choices[0].message.content;
        // Handle when OpenAI might wrap the JSON in markdown code blocks
        const jsonText = responseText.replace(/```json|```/g, '').trim();
        responseContent = JSON.parse(jsonText);
      } else {
        // Gemini processing
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }
        
        try {
          // Create Gemini message structure
          const geminiMessages = [
            {
              role: "user",
              parts: [
                {
                  text: `You are an expert coding interview assistant. Provide a clear, optimal solution with detailed explanations for this problem:\n\n${promptText}`
                }
              ]
            }
          ];

          // Make API request to Gemini
          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.solutionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 7000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;
          
          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }
          
          responseContent = responseData.candidates[0].content.parts[0].text;
        } catch (error) {
          console.error("Error using Gemini API for solution:", error);
          return {
            success: false,
            error: "Failed to generate solution with Gemini API. Please check your API key or try again later."
          };
        }
      }
      return { success: true, data: responseContent };
    } catch (error: any) {
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }
      
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid OpenAI API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "OpenAI API rate limit exceeded or insufficient credits. Please try again later."
        };
      }
      
      console.error("Solution generation error:", error);
      return { success: false, error: error.message || "Failed to generate solution" };
    }
  }

  private async processExtraScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal
  ) {
    try {
      const problemInfo = this.deps.getProblemInfo();
      const language = await this.getLanguage();
      const config = configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();

      if (!problemInfo) {
        throw new Error("No problem info available");
      }

      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Processing debug screenshots...",
          progress: 30
        });
      }

      // Prepare the images for the API call
      const imageDataList = screenshots.map(screenshot => screenshot.data);
      
      let debugContent;
      
      if (config.apiProvider === "openai") {
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings."
          };
        }
        
        const messages = [
          {
            role: "system" as const, 
            content: `You are a coding interview assistant helping debug and improve solutions. Analyze these screenshots which include either error messages, incorrect outputs, or test cases, and provide detailed debugging help.

Your response MUST follow this exact structure with these section headers (use ### for headers):
### Issues Identified
- List each issue as a bullet point with clear explanation

### Specific Improvements and Corrections
- List specific code changes needed as bullet points

### Optimizations
- List any performance optimizations if applicable

### Explanation of Changes Needed
Here provide a clear explanation of why the changes are needed

### Key Points
- Summary bullet points of the most important takeaways

If you include code examples, use proper markdown code blocks with language specification (e.g. \`\`\`java).`
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const, 
                text: `I'm solving this coding problem: "${problemInfo.problem_statement}" in ${language}. I need help with debugging or improving my solution. Here are screenshots of my code, the errors or test cases. Please provide a detailed analysis with:
1. What issues you found in my code
2. Specific improvements and corrections
3. Any optimizations that would make the solution better
4. A clear explanation of the changes needed` 
              },
              ...imageDataList.map(data => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` }
              }))
            ]
          }
        ];

        if (mainWindow) {
          mainWindow.webContents.send("processing-status", {
            message: "Analyzing code and generating debug feedback...",
            progress: 60
          });
        }

        const debugResponse = await this.openaiClient.chat.completions.create({
          model: config.debuggingModel || "gpt-4o",
          messages: messages,
          max_tokens: 4000,
          temperature: 0.2
        });
        
        debugContent = debugResponse.choices[0].message.content;
      } else {
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }
        
        try {
          const debugPrompt = `
You are a coding interview assistant helping debug and improve solutions. Analyze these screenshots which include either error messages, incorrect outputs, or test cases, and provide detailed debugging help.

I'm solving this coding problem: "${problemInfo.problem_statement}" in ${language}. I need help with debugging or improving my solution.

YOUR RESPONSE MUST FOLLOW THIS EXACT STRUCTURE WITH THESE SECTION HEADERS:
### Issues Identified
- List each issue as a bullet point with clear explanation

### Specific Improvements and Corrections
- List specific code changes needed as bullet points

### Optimizations
- List any performance optimizations if applicable

### Explanation of Changes Needed
Here provide a clear explanation of why the changes are needed

### Key Points
- Summary bullet points of the most important takeaways

If you include code examples, use proper markdown code blocks with language specification (e.g. \`\`\`java).
`;

          const geminiMessages = [
            {
              role: "user",
              parts: [
                { text: debugPrompt },
                ...imageDataList.map(data => ({
                  inlineData: {
                    mimeType: "image/png",
                    data: data
                  }
                }))
              ]
            }
          ];

          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "Analyzing code and generating debug feedback with Gemini...",
              progress: 60
            });
          }

          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.debuggingModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;
          
          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }
          
          debugContent = responseData.candidates[0].content.parts[0].text;
        } catch (error) {
          console.error("Error using Gemini API for debugging:", error);
          return {
            success: false,
            error: "Failed to process debug request with Gemini API. Please check your API key or try again later."
          };
        }
      }
      
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Debug analysis complete",
          progress: 100
        });
      }

      let extractedCode = "// Debug mode - see analysis below";
      const codeMatch = debugContent.match(/```(?:[a-zA-Z]+)?([\s\S]*?)```/);
      if (codeMatch && codeMatch[1]) {
        extractedCode = codeMatch[1].trim();
      }

      let formattedDebugContent = debugContent;
      
      if (!debugContent.includes('# ') && !debugContent.includes('## ')) {
        formattedDebugContent = debugContent
          .replace(/issues identified|problems found|bugs found/i, '## Issues Identified')
          .replace(/code improvements|improvements|suggested changes/i, '## Code Improvements')
          .replace(/optimizations|performance improvements/i, '## Optimizations')
          .replace(/explanation|detailed analysis/i, '## Explanation');
      }

      const bulletPoints = formattedDebugContent.match(/(?:^|\n)[ ]*(?:[-*•]|\d+\.)[ ]+([^\n]+)/g);
      const thoughts = bulletPoints 
        ? bulletPoints.map(point => point.replace(/^[ ]*(?:[-*•]|\d+\.)[ ]+/, '').trim()).slice(0, 5)
        : ["Debug analysis based on your screenshots"];
      
      const response = {
        code: extractedCode,
        debug_analysis: formattedDebugContent,
        thoughts: thoughts,
        time_complexity: "N/A - Debug mode",
        space_complexity: "N/A - Debug mode"
      };

      return { success: true, data: response };
    } catch (error: any) {
      console.error("Debug processing error:", error);
      return { success: false, error: error.message || "Failed to process debug request" };
    }
  }

  private async processBugfixScreenshot(screenshots: Array<{ path: string; data: string }>, signal: AbortSignal) {
    try {
      const config = configHelper.loadConfig();
      const language = await this.getLanguage();
      
      // Create prompt for bugfix analysis
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Analyzing code for bugs and issues...",
          progress: 20
        });
      }

      let bugfixContent;

      if (this.openaiClient) {
        const response = await this.openaiClient.chat.completions.create({
          model: config.extractionModel || "gpt-4o",
          messages: [
            {
              role: "system",
              content: `You are an expert coding interview assistant specializing in bug detection and code fixing. Analyze these screenshots which contain code that needs debugging or improvement. Provide a comprehensive analysis with clear explanations and fixed code.`
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `I need help finding and fixing bugs in this ${language} code. Please analyze the screenshots and provide:

1. **Bug Identification**: List all bugs, errors, or issues found in the code
2. **Root Cause Analysis**: Explain why each bug occurs
3. **Fixed Code**: Provide the corrected version of the code
4. **Improvements**: Suggest additional optimizations or best practices
5. **Testing**: Recommend how to test the fixes

Please be thorough in your analysis and provide clear, actionable solutions.`
                },
                ...screenshots.map(screenshot => ({
                  type: "image_url" as const,
                  image_url: {
                    url: `data:image/png;base64,${screenshot.data}`,
                    detail: "high" as const
                  }
                }))
              ]
            }
          ],
          max_tokens: 4000
        }, { signal });

        bugfixContent = response.choices[0].message.content;
      } else if (this.geminiApiKey) {
        if (mainWindow) {
          mainWindow.webContents.send("processing-status", {
            message: "Analyzing code for bugs with Gemini...",
            progress: 30
          });
        }

        const bugfixPrompt = `You are an expert coding interview assistant specializing in bug detection and code fixing. Analyze these screenshots which contain code that needs debugging or improvement.

I need help finding and fixing bugs in this ${language} code. Please analyze the screenshots and provide:

1. **Bug Identification**: List all bugs, errors, or issues found in the code
2. **Root Cause Analysis**: Explain why each bug occurs  
3. **Fixed Code**: Provide the corrected version of the code
4. **Improvements**: Suggest additional optimizations or best practices
5. **Testing**: Recommend how to test the fixes

Please be thorough in your analysis and provide clear, actionable solutions.`;

        const geminiMessages = [
          {
            role: "user",
            parts: [
              { text: bugfixPrompt },
              ...screenshots.map(screenshot => ({
                inlineData: {
                  mimeType: "image/png",
                  data: screenshot.data
                }
              }))
            ]
          }
        ];

        const response = await axios.default.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${config.extractionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
          {
            contents: geminiMessages,
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 4000
            }
          },
          { signal }
        );

        bugfixContent = response.data.candidates[0].content.parts[0].text;
      } else {
        return {
          success: false,
          error: "No AI client available. Please configure your API key in settings."
        };
      }

      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Bugfix analysis complete",
          progress: 100
        });
      }

      let extractedCode = "// Bugfix mode - see analysis below";
      const codeMatch = bugfixContent.match(/```(?:[a-zA-Z]+)?([\s\S]*?)```/);
      if (codeMatch && codeMatch[1]) {
        extractedCode = codeMatch[1].trim();
      }

      let formattedBugfixContent = bugfixContent;
      
      if (!bugfixContent.includes('# ') && !bugfixContent.includes('## ')) {
        formattedBugfixContent = bugfixContent
          .replace(/bug identification|bugs found|issues found/i, '## Bug Identification')
          .replace(/root cause|root cause analysis/i, '## Root Cause Analysis')
          .replace(/fixed code|corrected code|solution/i, '## Fixed Code')
          .replace(/improvements|optimizations|best practices/i, '## Improvements')
          .replace(/testing|test cases/i, '## Testing Recommendations');
      }

      const bulletPoints = formattedBugfixContent.match(/(?:^|\n)[ ]*(?:[-*•]|\d+\.)[ ]+([^\n]+)/g);
      const thoughtSteps = bulletPoints 
        ? bulletPoints.map((point: string) => point.replace(/^[\s\-*•\d\.]+/, '').trim())
        : ["Bugfix analysis based on your screenshots"];

      return {
        success: true,
        data: {
          debug_analysis: formattedBugfixContent,
          code: extractedCode,
          time_complexity: "N/A - Bugfix mode",
          space_complexity: "N/A - Bugfix mode"
        }
      };
    } catch (error: any) {
      console.error("Bugfix processing error:", error);
      return { success: false, error: error.message || "Failed to process bugfix request" };
    }
  }

  public cancelOngoingRequests(): void {
    let wasCancelled = false

    if (this.currentProcessingAbortController) {
      this.currentProcessingAbortController.abort()
      this.currentProcessingAbortController = null
      wasCancelled = true
    }

    if (this.currentExtraProcessingAbortController) {
      this.currentExtraProcessingAbortController.abort()
      this.currentExtraProcessingAbortController = null
      wasCancelled = true
    }

    this.deps.setHasDebugged(false)

    this.deps.setProblemInfo(null)

    const mainWindow = this.deps.getMainWindow()
    if (wasCancelled && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS)
    }
  }

  private async generateImprovedCode(
    problemInfo: any,
    language: string,
    signal: AbortSignal
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      const config = configHelper.loadConfig();
      
      if (!config.apiProvider || config.apiProvider === "openai") {
        // Use OpenAI API
        if (!this.openaiClient) {
          this.initializeAIClient(); // Try to reinitialize
          
          if (!this.openaiClient) {
            return {
              success: false,
              error: "OpenAI API key not configured or invalid. Please check your settings."
            };
          }
        }

        const messages = [
          {
            role: "system" as const,
            content: `You are an expert ${language} developer. Your task is to analyze the provided code and improve it by:

1. Completing any unfinished code sections
2. Fixing potential bugs or issues
3. Improving code quality and best practices
4. Adding proper error handling where needed
5. Optimizing performance if applicable

Return your response as a JSON object with the following structure:
{
  "type": "code",
  "language": "${language}",
  "explanation": "Clear explanation of what was improved and why",
  "issues": ["List of issues found and fixed"],
  "completed_code": "The complete, improved version of the code"
}

Focus on making the code production-ready and following best practices for ${language}.`
          },
          {
            role: "user" as const,
            content: `Please analyze and improve the following ${language} code:

**Original Code:**
\`\`\`${language}
${problemInfo.completed_code}
\`\`\`

**Current Analysis:**
${problemInfo.explanation}

**Language:** ${language}

Please provide a complete, improved version of this code that addresses any issues and follows best practices.`
          }
        ];

        const response = await this.openaiClient.chat.completions.create({
          model: config.extractionModel || "gpt-4o",
          messages: messages,
          max_tokens: 4000,
          temperature: 0.2
        }, { signal });

        try {
          const responseText = response.choices[0].message.content;
          const jsonText = responseText.replace(/```json|```/g, '').trim();
          const improvedCode = JSON.parse(jsonText);
          
          console.log('=== IMPROVED CODE (OpenAI) ===');
          console.log(JSON.stringify(improvedCode, null, 2));
          console.log('==============================');
          
          return { success: true, data: improvedCode };
        } catch (error) {
          console.error("Error parsing OpenAI improved code response:", error);
          return {
            success: false,
            error: "Failed to parse improved code response."
          };
        }
      } else {
        // Use Gemini API
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }

        const geminiMessages = [
          {
            role: "user",
            parts: [
              {
                text: `You are an expert ${language} developer. Your task is to analyze the provided code and improve it by:

1. Completing any unfinished code sections
2. Fixing potential bugs or issues
3. Improving code quality and best practices
4. Adding proper error handling where needed
5. Optimizing performance if applicable

Return your response as a JSON object with the following structure:
{
  "type": "code",
  "language": "${language}",
  "explanation": "Clear explanation of what was improved and why",
  "issues": ["List of issues found and fixed"],
  "completed_code": "The complete, improved version of the code"
}

Focus on making the code production-ready and following best practices for ${language}.

Please analyze and improve the following ${language} code:

**Original Code:**
\`\`\`${language}
${problemInfo.completed_code}
\`\`\`

**Current Analysis:**
${problemInfo.explanation}

**Language:** ${language}

Please provide a complete, improved version of this code that addresses any issues and follows best practices.`
              }
            ]
          }
        ];

        const response = await axios.default.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${config.extractionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
          {
            contents: geminiMessages,
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 4000
            }
          },
          { signal }
        );

        const responseData = response.data;
        
        if (!responseData.candidates || responseData.candidates.length === 0) {
          throw new Error("Empty response from Gemini API");
        }
        
        const responseText = responseData.candidates[0].content.parts[0].text;
        const jsonText = responseText.replace(/```json|```/g, '').trim();
        const improvedCode = JSON.parse(jsonText);
        
        console.log('=== IMPROVED CODE (Gemini) ===');
        console.log(JSON.stringify(improvedCode, null, 2));
        console.log('==============================');
        
        return { success: true, data: improvedCode };
      }
    } catch (error: any) {
      console.error("Error generating improved code:", error);
      
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Code improvement was canceled by the user."
        };
      }
      
      return {
        success: false,
        error: "Failed to generate improved code. Please try again."
      };
    }
  }
}