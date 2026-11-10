import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useFloatingPosition } from "./floating";
import { Icon } from "./Icon";
import { addTokens, remainingText, splitEntry, tagKey, tokenKeys } from "./tokenInputModel";
import "./TokenInput.css";

export interface Token {
  value: string;
  /** Present on only some of the selected items (bulk editing). */
  mixed?: boolean;
}

export interface TokenInputProps {
  inputId?: string;
  inputRef?: RefObject<HTMLInputElement>;
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  announceSuggestions?: boolean;
  /** An ordered list can own free-text entry while this control owns suggestion selection. */
  onSubmitEntry?: (value: string) => void;
  /** An ordered list can validate and deduplicate the whole pasted list itself. */
  onPasteEntries?: (values: string[]) => void;
  label: string;
  tokens: Token[];
  onChange: (tokens: Token[]) => void;
  /** Image tags allow 40 characters and 20 tags; video tags allow 80 and 30. */
  maxLength: number;
  /**
   * The tag count limit for one item. Omit it in bulk editing: the tokens there are the
   * union across the selected items, so the bulk plan enforces the per-item limit instead.
   */
  maxCount?: number;
  /** Preserve distinct spellings when the consuming taxonomy matches exact case. */
  caseSensitive?: boolean;
  /** Known tags from loaded data only; the field never requests suggestions. */
  suggestions?: string[];
  /** Where the suggestions come from, shown as the list's last line and not as an option. */
  suggestionsNote?: string;
  /** Bulk editing: typing a mixed tag puts it on every item instead of being refused. */
  promoteMixed?: boolean;
  /** Called once per commit with the tags it added or made solid, such as to record recent tags. */
  onCommit?: (values: string[]) => void;
  /** Makes unfinished text observable, such as for an unsaved-changes guard. */
  draft?: string;
  onDraftChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

// A tag field: comma or Return makes a token, pasted lists split at the cursor, Backspace in an
// empty field marks and then removes the last token, and suggestions follow the combobox pattern.
// The field is one tab stop; ArrowLeft and ArrowRight move between the tokens' remove buttons.
// Tokens keep their stored spelling because the video backend matches tags exactly.
export function TokenInput({
  inputId,
  inputRef: providedInputRef,
  ariaDescribedBy,
  ariaInvalid,
  announceSuggestions = false,
  onSubmitEntry,
  onPasteEntries,
  disabled = false,
  caseSensitive = false,
  draft,
  label,
  maxCount,
  maxLength,
  onChange,
  onCommit,
  onDraftChange,
  placeholder = "Add tag…",
  promoteMixed = false,
  suggestions = [],
  suggestionsNote,
  tokens,
}: TokenInputProps) {
  const localInputRef = useRef<HTMLInputElement>(null);
  const inputRef = providedInputRef ?? localInputRef;
  const fieldRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const removeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
  const composing = useRef(false);
  const [localText, setLocalText] = useState("");
  const text = draft ?? localText;
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [active, setActive] = useState(-1);
  const [listDismissed, setListDismissed] = useState(false);
  const listId = useId();
  const noteId = useId();
  const statusId = useId();

  function setText(value: string) {
    if (draft === undefined) setLocalText(value);
    onDraftChange?.(value);
  }

  // A mixed tag stays a suggestion in bulk editing, where choosing it puts it on every item.
  const key = caseSensitive ? (value: string) => value : tagKey;
  const used = new Set(tokens.filter((token) => !(promoteMixed && token.mixed)).map((token) => key(token.value)));
  const query = tagKey(text.trim());
  const matches = query
    ? suggestions.filter((item) => tagKey(item).startsWith(query) && !used.has(key(item))).slice(0, 8)
    : [];
  const expanded = matches.length > 0 && !listDismissed && !disabled;
  const lastToken = tokens[tokens.length - 1];
  const status = pending && lastToken ? `Press Backspace again to remove ${lastToken.value}.` : message;
  const keys = tokenKeys(tokens);
  removeRefs.current.length = tokens.length;

  // The list is placed on the fixed layer beside the field, so a scrolling panel such as the
  // inspector's body cannot clip it; it flips above the field when there is no room below.
  const position = useFloatingPosition(
    expanded,
    () => fieldRef.current?.getBoundingClientRect() ?? null,
    popupRef,
    "bottom-start",
    () => fieldRef.current,
  );
  const [listWidth, setListWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!expanded || !field) return;
    const measure = () => setListWidth(field.getBoundingClientRect().width || null);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(field);
    return () => observer.disconnect();
  }, [expanded]);

  useEffect(() => {
    const option = expanded && active >= 0 ? optionRefs.current[active] : null;
    if (option && typeof option.scrollIntoView === "function") option.scrollIntoView({ block: "nearest" });
  }, [active, expanded]);

  /** Returns how many values were accepted; refused values are left for the caller to keep. */
  function commit(values: string[]) {
    const result = addTokens(tokens, values, { maxCount, maxLength, promoteMixed, caseSensitive });
    setMessage(result.error);
    setPending(false);
    setActive(-1);
    if (result.accepted > 0) {
      onChange(result.tokens);
      const promoted = tokens.filter((token, index) => token.mixed && !result.tokens[index].mixed);
      onCommit?.([...promoted, ...result.tokens.slice(tokens.length)].map((token) => token.value));
    }
    return result;
  }

  function remove(index: number, focusTarget?: HTMLElement | null) {
    onChange(tokens.filter((_, position) => position !== index));
    setPending(false);
    setMessage("");
    (focusTarget ?? inputRef.current)?.focus();
  }

  function enter(value: string) {
    const { complete, rest } = splitEntry(value);
    if (complete.length === 0) {
      setText(value);
      setActive(-1);
      return;
    }
    setText(remainingText(commit(complete).rejected, rest));
  }

  function onType(value: string) {
    setListDismissed(false);
    setPending(false);
    if (composing.current || onSubmitEntry) {
      setText(value);
      setActive(-1);
      return;
    }
    enter(value);
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!/[,\n]/.test(pasted)) return;
    event.preventDefault();
    const start = event.currentTarget.selectionStart ?? text.length;
    const end = event.currentTarget.selectionEnd ?? start;
    setListDismissed(false);
    const composed = `${text.slice(0, start)}${pasted}${text.slice(end)}`;
    if (onPasteEntries) {
      onPasteEntries(composed.split(/[,\n]/));
      setText("");
      setMessage("");
      setActive(-1);
    } else enter(composed);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!expanded) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => current < 0
        ? (step > 0 ? 0 : matches.length - 1)
        : (current + step + matches.length) % matches.length);
      return;
    }
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopPropagation();
      setListDismissed(true);
      return;
    }
    if (event.key === "Enter") {
      if (onSubmitEntry && !(expanded && active >= 0)) {
        event.preventDefault();
        onSubmitEntry(text);
        return;
      }
      const chosen = expanded && active >= 0 ? matches[active] : text;
      if (!chosen.trim()) return;
      event.preventDefault();
      if (commit([chosen]).accepted > 0) setText("");
      return;
    }
    const input = event.currentTarget;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    if (event.key === "ArrowLeft" && atStart && tokens.length > 0) {
      event.preventDefault();
      setPending(false);
      removeRefs.current[tokens.length - 1]?.focus();
      return;
    }
    if (event.key === "Backspace" && text === "" && tokens.length > 0) {
      event.preventDefault();
      if (pending) remove(tokens.length - 1);
      else {
        setMessage("");
        setPending(true);
      }
      return;
    }
    if (pending) setPending(false);
  }

  function onTokenKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      removeRefs.current[Math.max(index - 1, 0)]?.focus();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      (index < tokens.length - 1 ? removeRefs.current[index + 1] : inputRef.current)?.focus();
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      remove(index, index > 0 ? removeRefs.current[index - 1] : null);
    }
  }

  return (
    <div className="ui-token-input">
      <div className="ui-token-anchor">
        <div
          className={disabled ? "ui-token-field ui-token-field-disabled" : "ui-token-field"}
          onClick={() => inputRef.current?.focus()}
          ref={fieldRef}
        >
          {tokens.map((token, index) => {
            const marked = pending && index === tokens.length - 1;
            const classes = [
              "ui-token",
              token.mixed ? "ui-token-mixed" : null,
              marked ? "ui-token-pending" : null,
            ].filter(Boolean).join(" ");
            return (
              <span className={classes} key={keys[index]}>
                <span className="ui-token-value">{token.value}</span>
                {token.mixed ? <span aria-hidden="true" className="ui-token-mixed-label">mixed</span> : null}
                <button
                  aria-describedby={marked ? statusId : undefined}
                  aria-label={`Remove tag ${token.value}${token.mixed ? ", on some items" : ""}`}
                  className="ui-token-remove"
                  disabled={disabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(index);
                  }}
                  onKeyDown={(event) => onTokenKeyDown(event, index)}
                  ref={(element) => {
                    removeRefs.current[index] = element;
                  }}
                  tabIndex={-1}
                  type="button"
                >
                  <Icon name="close" />
                </button>
              </span>
            );
          })}
          <input
            id={inputId}
            aria-describedby={ariaDescribedBy}
            aria-invalid={ariaInvalid || undefined}
            aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={expanded}
            aria-label={label}
            className="ui-token-text"
            disabled={disabled}
            onBlur={() => {
              setPending(false);
              setListDismissed(true);
            }}
            onChange={(event) => onType(event.target.value)}
            onCompositionEnd={(event) => {
              composing.current = false;
              onType(event.currentTarget.value);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={placeholder}
            ref={inputRef}
            role="combobox"
            type="text"
            value={text}
          />
        </div>
        <div
          className="ui-token-popup"
          data-positioned={position ? "true" : "false"}
          hidden={!expanded}
          // Pressing the note or the list's padding keeps focus, and the list, in the field.
          onMouseDown={(event) => event.preventDefault()}
          ref={popupRef}
          style={position ? { left: position.left, top: position.top, width: listWidth ?? undefined } : undefined}
        >
          <ul
            aria-describedby={expanded && suggestionsNote ? noteId : undefined}
            className="ui-token-options"
            id={listId}
            role="listbox"
          >
            {expanded ? matches.map((item, index) => (
              <li
                aria-selected={index === active}
                className="ui-token-option"
                id={`${listId}-${index}`}
                key={item}
                onMouseDown={() => {
                  if (commit([item]).accepted > 0) setText("");
                }}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                role="option"
              >
                {item}
              </li>
            )) : null}
          </ul>
          {expanded && suggestionsNote ? (
            <p className="ui-token-note" id={noteId}>{suggestionsNote}</p>
          ) : null}
        </div>
      </div>
      <p
        aria-live="polite"
        className={pending ? "ui-token-message ui-token-message-hint" : "ui-token-message"}
        id={statusId}
        role="status"
      >
        {status}
        {announceSuggestions && query && !disabled && !listDismissed ? <span className="sr-only">{
          expanded ? `${matches.length} suggestions available. Use arrow keys to choose.` : "No matching suggestions."
        }</span> : null}
      </p>
    </div>
  );
}
