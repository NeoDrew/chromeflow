/** Distribute Omit over each member of a discriminated union */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

// Messages sent from MCP server → Extension (via WebSocket)
export type ServerMessage =
  | { type: "navigate"; requestId: string; url: string; newTab?: boolean }
  | { type: "switch_to_tab"; requestId: string; query: string }
  | { type: "screenshot"; requestId: string }
  | { type: "find_highlight"; requestId: string; text: string; message: string; valueToType?: string }
  | {
      type: "highlight_region";
      requestId: string;
      selector?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
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
  | { type: "get_page_text"; requestId: string; selector?: string; startIndex?: number }
  | { type: "wait_for_selector"; requestId: string; selector: string; timeout: number; refresh?: number }
  | { type: "execute_script"; requestId: string; code: string }
  | { type: "get_elements"; requestId: string }
  | { type: "get_form_fields"; requestId: string }
  | { type: "scroll_to_element"; requestId: string; query: string }
  | { type: "save_page_state"; requestId: string }
  | { type: "restore_page_state"; requestId: string; state: PageFieldState[] }
  | { type: "list_tabs"; requestId: string }
  | { type: "fill_form"; requestId: string; fields: Array<{ label: string; value: string }> }
  | { type: "set_file_input"; requestId: string; hint: string; filePath: string };

export type PageFieldState = {
  selector: string;
  type: string;
  value: string;
  checked?: boolean;
};

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
  | { type: "script_response"; requestId: string; result: string; alert?: string | null }
  | { type: "error"; requestId: string; message: string }
  | { type: "elements_response"; requestId: string; elements: Array<{ index: number; type: string; label: string; value: string; x: number; y: number; width: number; height: number }> }
  | { type: "form_fields_response"; requestId: string; fields: Array<{ index: number; type: string; label: string; value: string; y: number; selector: string }> }
  | { type: "save_state_response"; requestId: string; state: PageFieldState[] }
  | { type: "tabs_response"; requestId: string; tabs: Array<{ index: number; title: string; url: string; active: boolean }> }
  | { type: "fill_form_response"; requestId: string; results: Array<{ label: string; success: boolean; message: string }>; succeeded: number; total: number };
