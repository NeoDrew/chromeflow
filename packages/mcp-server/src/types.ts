/** Distribute Omit over each member of a discriminated union */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

// Messages sent from MCP server → Extension (via WebSocket)
export type ServerMessage =
  | { type: "navigate"; requestId: string; url: string }
  | { type: "screenshot"; requestId: string }
  | { type: "find_highlight"; requestId: string; text: string; message: string; valueToType?: string }
  | {
      type: "highlight_region";
      requestId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      message: string;
      valueToType?: string;
    }
  | {
      type: "show_panel";
      requestId: string;
      title: string;
      steps: Array<{ text: string; done?: boolean }>;
    }
  | { type: "read_element"; requestId: string; textHint: string }
  | { type: "clear"; requestId: string }
  // Flow control — reactive progression
  | { type: "start_click_watch"; requestId: string; timeout: number }
  | { type: "mark_step_done"; requestId: string; stepIndex: number }
  | { type: "fill_input"; requestId: string; textHint: string; value: string }
  | { type: "click_element"; requestId: string; textHint: string }
  | { type: "scroll_page"; requestId: string; direction: "down" | "up"; amount: number }
  | { type: "get_page_text"; requestId: string; selector?: string }
  | { type: "wait_for_selector"; requestId: string; selector: string; timeout: number }
  | { type: "execute_script"; requestId: string; code: string };

// Messages sent from Extension → MCP server
export type ClientMessage =
  | { type: "ready" }
  | {
      type: "screenshot_response";
      requestId: string;
      image: string;
      width: number;
      height: number;
    }
  | { type: "find_highlight_response"; requestId: string; found: boolean }
  | { type: "action_done"; requestId: string }
  | { type: "read_response"; requestId: string; value: string | null }
  | { type: "click_detected"; requestId: string }
  | { type: "navigation_complete"; requestId: string; url: string }
  | { type: "fill_response"; requestId: string; success: boolean; message: string }
  | { type: "click_element_response"; requestId: string; success: boolean; message: string }
  | { type: "page_text_response"; requestId: string; text: string }
  | { type: "script_response"; requestId: string; result: string }
  | { type: "error"; requestId: string; message: string };
