import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Select, type SelectProps } from "antd";
import { useMediaQuery } from "@/lib/media";

/** On phones, browse first; a second tap on the selector opts into typing. */
export function TaxonomySelect(props: SelectProps<string[]>) {
  const mobile = useMediaQuery("(max-width: 767px)");
  const [typing, setTyping] = useState(false);
  const open = useRef(false);
  const enableTypingOnClick = useRef(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const canType = !mobile || typing;
  return <div
    ref={wrapper}
    className="taxonomy-select"
    onPointerDownCapture={(event) => {
      const target = event.target instanceof Element ? event.target : null;
      enableTypingOnClick.current = Boolean(mobile && open.current && !typing && !props.disabled && target?.closest(".ant-select-selector") && !target.closest(".ant-select-selection-item-remove, .ant-select-clear"));
    }}
    onMouseDownCapture={(event) => {
      // rc-select toggles the dropdown on mousedown. Keep the second tap open
      // until click enables the input synchronously within the user gesture.
      if (enableTypingOnClick.current) { event.preventDefault(); event.stopPropagation(); }
    }}
    onClickCapture={(event) => {
      if (!enableTypingOnClick.current) return;
      enableTypingOnClick.current = false;
      event.preventDefault();
      event.stopPropagation();
      flushSync(() => setTyping(true));
      wrapper.current?.querySelector<HTMLInputElement>("input[role='combobox']")?.focus();
    }}
  >
    <Select
      {...props}
      mode={canType ? props.mode : "multiple"}
      showSearch={canType}
      onSearch={canType ? props.onSearch : undefined}
      onOpenChange={(next) => {
        open.current = next;
        if (!next) { setTyping(false); enableTypingOnClick.current = false; props.onSearch?.(""); }
        props.onOpenChange?.(next);
      }}
      onInputKeyDown={(event) => {
        // Preserve explicit keyboard navigation on phones with external keyboards.
        if (mobile && !typing && event.key.length === 1 && !event.ctrlKey && !event.metaKey) flushSync(() => setTyping(true));
        props.onInputKeyDown?.(event);
      }}
    />
  </div>;
}
