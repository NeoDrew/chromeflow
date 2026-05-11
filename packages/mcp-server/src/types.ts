/** Distribute Omit over each member of a discriminated union */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

// Messages sent from MCP server → Extension (via WebSocket)
export type ServerMessage =
  | { type: "navigate"; requestId: string; url: string; newTab?: boolean; background?: boolean }
  | { type: "switch_to_tab"; requestId: string; query: string }
  | { type: "screenshot"; requestId: string; grid?: boolean }
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
  | { type: "read_element"; requestId: string; textHint: string }
  | { type: "clear"; requestId: string }
  // Flow control — reactive progression
  | { type: "start_click_watch"; requestId: string; timeout: number }
  | { type: "fill_input"; requestId: string; textHint: string; value: string; nth?: number; exact?: boolean }
  | {
      type: "click_element";
      requestId: string;
      textHint: string;
      nth?: number;
      until_selector?: string;
      until_url_contains?: string;
      until_text_contains?: string;
      until_timeout_ms?: number;
    }
  | { type: "prepare_click_target"; requestId: string; textHint: string; nth?: number }
  | { type: "post_click_inspect"; requestId: string }
  | { type: "scroll_page"; requestId: string; direction: "down" | "up"; amount: number }
  | { type: "get_page_text"; requestId: string; selector?: string; startIndex?: number }
  | { type: "wait_for_selector"; requestId: string; selector: string; timeout: number; refresh?: number; shadow_root?: boolean }
  | { type: "wait_for_change"; requestId: string; selector: string; timeout: number; settle?: number }
  | { type: "execute_script"; requestId: string; code: string }
  | { type: "get_elements"; requestId: string }
  | { type: "get_form_fields"; requestId: string }
  | { type: "scroll_to_element"; requestId: string; query: string }
  | { type: "save_page_state"; requestId: string }
  | { type: "restore_page_state"; requestId: string; state: PageFieldState[] }
  | { type: "list_tabs"; requestId: string }
  | { type: "fill_form"; requestId: string; fields: Array<{ label: string; value: string }>; exact?: boolean }
  | { type: "set_file_input"; requestId: string; hint: string; filePath: string; waitMs?: number; verifySelector?: string }
  | { type: "type_text"; requestId: string; text: string; frame?: string }
  | { type: "inspect_request_headers"; requestId: string; url: string }
  | { type: "react_set_input"; requestId: string; selector: string; value: string; frame?: string }
  | {
      type: "react_call_prop";
      requestId: string;
      selector: string;
      prop_name: string;
      args: unknown[];
      max_depth: number;
      frame?: string;
    }
  | {
      type: "find_text";
      requestId: string;
      query: string;
      max?: number;
      scope_selector?: string;
      regex?: boolean;
      visible_only?: boolean;
      context_chars?: number;
      frame?: string;
    }
  | {
      type: "find_input";
      requestId: string;
      query: string;
      type_filter?: string;
      max?: number;
      exact?: boolean;
      frame?: string;
    }
  | {
      type: "wait_for_text";
      requestId: string;
      query: string;
      timeout_ms?: number;
      scope_selector?: string;
      regex?: boolean;
      frame?: string;
    };

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
  | { type: "fill_response"; requestId: string; success: boolean; message: string; matched?: string }
  | { type: "click_element_response"; requestId: string; success: boolean; message: string }
  | { type: "page_text_response"; requestId: string; text: string }
  | { type: "script_response"; requestId: string; result: string; alert?: string | null }
  | { type: "error"; requestId: string; message: string }
  | { type: "elements_response"; requestId: string; elements: Array<{ index: number; type: string; label: string; value: string; x: number; y: number; width: number; height: number }> }
  | { type: "form_fields_response"; requestId: string; fields: Array<{ index: number; type: string; label: string; value: string; y: number; selector: string }> }
  | { type: "save_state_response"; requestId: string; state: PageFieldState[] }
  | { type: "tabs_response"; requestId: string; tabs: Array<{ index: number; title: string; url: string; active: boolean }> }
  | { type: "fill_form_response"; requestId: string; results: Array<{ label: string; success: boolean; message: string; matched?: string }>; succeeded: number; total: number }
  | {
      type: "find_text_response";
      requestId: string;
      matches: Array<{
        text: string;
        context: string;
        selector: string;
        tag: string;
        role: string | null;
        clickable: boolean;
        position: { x: number; y: number; width: number; height: number } | null;
      }>;
      total_matches: number;
      truncated: boolean;
      scope_missed?: boolean;
      frame_error?: string;
    }
  | {
      type: "find_input_response";
      requestId: string;
      fields: Array<{
        label: string;
        placeholder: string;
        type: string;
        value: string;
        under?: string;
        position: { x: number; y: number; width: number; height: number } | null;
        match_kind: string;
      }>;
      total_matches: number;
      truncated: boolean;
      frame_error?: string;
    }
  | {
      type: "wait_for_text_response";
      requestId: string;
      found: boolean;
      selector?: string;
      text?: string;
      context?: string;
      elapsed_ms: number;
      frame_error?: string;
    };
