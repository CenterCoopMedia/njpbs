import { useId, useState, useRef, useEffect, type ComponentProps } from "react";
import { DEFAULT_POSTS_BROWSE, POSTS_BROWSE_ICONS, postsBrowseTermKey, validatePostsBrowse,
  type PostsBrowseConfig, type PostsBrowseGroup, type PostsBrowseTerm } from "../../../packages/content-core/src/posts-browse";
import type { PublishedVocabulary } from "../../../packages/content-core/src/published-vocabulary";
import { canonicalPostsBrowse } from "../lib/posts-browse-draft";
import { ActionControl } from "./ui/ActionControl";
import { Button, InlineMessage, Select as SelectControl, TextInput as InputControl } from "./ui/Primitives";
import "./PostsBrowseEditor.css";

function TextInput({ label, ...props }: ComponentProps<typeof InputControl> & { label: string }) {
  const id = useId();
  return <label className="editor-field-label" htmlFor={id}>{label}<InputControl {...props} id={id} /></label>;
}
function Select({ label, ...props }: ComponentProps<typeof SelectControl> & { label: string }) {
  const id = useId();
  return <label className="editor-field-label" htmlFor={id}>{label}<SelectControl {...props} id={id} /></label>;
}

interface Props {
  value?: PostsBrowseConfig;
  disabled: boolean;
  onChange: (value: PostsBrowseConfig) => void;
  loadVocabulary?: () => Promise<PublishedVocabulary>;
}
const iconNames = { ballot: "Ballot", heart: "Heart", train: "Train", leaf: "Leaf", play: "Play", pin: "Map pin" };
export function PostsBrowseEditor({ value, disabled, onChange, loadVocabulary }: Props) {
  const config = value ?? DEFAULT_POSTS_BROWSE;
  const rootRef = useRef<HTMLDetailsElement>(null);
  const ids = useRef(new WeakMap<object, string>());
  const nextId = useRef(0);
  const pendingFocus = useRef<string>();
  function termId(term: PostsBrowseTerm): string {
    let key = ids.current.get(term);
    if (!key) { key = `subject-${++nextId.current}`; ids.current.set(term, key); }
    return key;
  }
  function editedTerm(before: PostsBrowseTerm, after: PostsBrowseTerm): PostsBrowseTerm {
    ids.current.set(after, termId(before)); return after;
  }
  function focusAfter(selector: string) { pendingFocus.current = selector; }

  const [vocabulary, setVocabulary] = useState<PublishedVocabulary>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [activeGroup, setActiveGroup] = useState<string>();
  const [message, setMessage] = useState("");
  const id = useId();
  useEffect(() => {
    if (!pendingFocus.current) return;
    const target = rootRef.current?.querySelector<HTMLElement>(pendingFocus.current);
    if (target) { pendingFocus.current = undefined; target.focus(); }
  }, [config, activeGroup]);
  async function load() {
    if (!loadVocabulary || loading) return;
    setLoading(true); setFailed(false);
    try { setVocabulary(await loadVocabulary()); }
    catch { setFailed(true); }
    finally { setLoading(false); }
  }
  function change(groups: readonly PostsBrowseGroup[]) { onChange({ groups }); }
  function update(index: number, group: PostsBrowseGroup) { change(config.groups.map((item, at) => at === index ? group : item)); }
  function move(index: number, delta: number) {
    const groups = [...config.groups], target = index + delta;
    if (target < 0 || target >= groups.length) return;
    [groups[index], groups[target]] = [groups[target], groups[index]];
    focusAfter(`[data-posts-group="${groups[target].id}"] > details > summary`);
    change(groups); setMessage(`${groups[target].label} moved to position ${target + 1} of ${groups.length}.`);
  }
  function setTerms(index: number, terms: readonly PostsBrowseTerm[]) {
    const group = config.groups[index];
    const { cover, ...rest } = group;
    const previous = cover && group.terms.find(term => postsBrowseTermKey(term) === postsBrowseTermKey(cover));
    const nextCover = previous && terms.find(term => termId(term) === termId(previous));
    update(index, { ...rest, terms, ...(nextCover ? { cover: nextCover } : {}) });
    if (cover && !nextCover) setMessage("Cover subject removed. This group will use its first available image.");
  }
  function moveTerm(groupIndex: number, termIndex: number, delta: number) {
    const terms = [...config.groups[groupIndex].terms], target = termIndex + delta;
    if (target < 0 || target >= terms.length) return;
    [terms[termIndex], terms[target]] = [terms[target], terms[termIndex]];
    focusAfter(`[data-posts-subject="${termId(terms[target])}"] input`);
    setTerms(groupIndex, terms); setMessage(`Subject moved to position ${target + 1}.`);
  }
  const error = validatePostsBrowse(canonicalPostsBrowse(config));
  return <details ref={rootRef} className="settings-card posts-browse-editor" onToggle={event => {
    if (event.target !== event.currentTarget) return;
    setExpanded(event.currentTarget.open);
    if (event.currentTarget.open && !vocabulary && !loading && !failed) void load();
  }}>
    <summary>Posts browsing · {config.groups.length} {config.groups.length === 1 ? "group" : "groups"}</summary>
    {expanded && <>
    <p>Arrange the groups on the public Posts page. Subjects not assigned to a group stay in All topics &amp; categories. Removing a subject here keeps its Posts and links.</p>
    <p className="muted">Cover art follows the newest published Post with an image for the chosen cover subject. Save draft and Publish below apply to this arrangement and the navigation together.</p>
    <p role="status" aria-live="polite" className="sr-only">{message}</p>
    {loading && <p role="status">Loading published subjects…</p>}
    {failed && <InlineMessage tone="warning">Published subjects could not be loaded. Saved subjects remain available. <Button onClick={() => void load()} disabled={loading}>Retry subjects</Button></InlineMessage>}
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
    <datalist id={`${id}-categories`}>{vocabulary?.categories.map(term => <option key={term} value={term} />)}</datalist>
    <datalist id={`${id}-tags`}>{vocabulary?.tags.map(term => <option key={term} value={term} />)}</datalist>
    <ol className="posts-browse-editor__groups">
      {config.groups.map((group, index) => <li key={group.id} data-posts-group={group.id}>
        <details open={activeGroup === group.id} onToggle={event => { if (event.target === event.currentTarget) { const isOpen = event.currentTarget.open; setActiveGroup(current => isOpen ? group.id : current === group.id ? undefined : current); } }}>
          <summary>{group.label || "Unnamed group"} · {group.terms.length} {group.terms.length === 1 ? "subject" : "subjects"}</summary>
          {activeGroup === group.id && <>
          <div className="posts-browse-editor__heading">
            <TextInput label="Group name" value={group.label} disabled={disabled} onChange={event => update(index, { ...group, label: event.target.value })} onBlur={() => { if (group.label.trim() !== group.label) update(index, { ...group, label: group.label.trim() }); }} />
            <Select label="Group icon" value={group.icon} disabled={disabled} onChange={event => update(index, { ...group, icon: event.target.value as PostsBrowseGroup["icon"] })}>
              {POSTS_BROWSE_ICONS.map(icon => <option key={icon} value={icon}>{iconNames[icon]}</option>)}
            </Select>
            <div className="posts-browse-editor__actions">
              <ActionControl action="move-up" accessibleName={`Move up, ${group.label}`} disabled={disabled || index === 0} onClick={() => move(index, -1)} />
              <ActionControl action="move-down" accessibleName={`Move down, ${group.label}`} disabled={disabled || index === config.groups.length - 1} onClick={() => move(index, 1)} />
              <ActionControl action="remove-item" accessibleName={`Remove group, ${group.label}`} disabled={disabled} onClick={() => { const remaining = config.groups.filter((_, at) => at !== index); const neighbor = remaining[index] ?? remaining[index - 1]; focusAfter(neighbor ? `[data-posts-group="${neighbor.id}"] > details > summary` : "[data-add-browse-group]"); change(remaining); setMessage(`${group.label} removed from the arrangement. Its subjects remain available.`); }} />
            </div>
          </div>
          <Select label="Cover subject" value={group.cover ? postsBrowseTermKey(group.cover) : ""} disabled={disabled} onChange={event => {
            const { cover: _cover, ...rest } = group;
            const cover = group.terms.find(term => postsBrowseTermKey(term) === event.target.value);
            update(index, { ...rest, ...(cover ? { cover } : {}) });
          }}>
            <option value="">First available image in this group</option>
            {group.terms.map((term, at) => <option key={at} value={postsBrowseTermKey(term)}>{term.filter === "category" ? "Category" : "Topic"}: {term.value || "Unnamed subject"}</option>)}
          </Select>
          <ol className="posts-browse-editor__terms">{group.terms.map((term, at) => <li key={termId(term)} data-posts-subject={termId(term)}>
            <Select label={`Subject ${at + 1} type`} value={term.filter} disabled={disabled} onChange={event => setTerms(index, group.terms.map((item, n) => n === at ? editedTerm(item, { ...item, filter: event.target.value as PostsBrowseTerm["filter"] }) : item))}>
              <option value="category">Category</option><option value="tag">Topic</option>
            </Select>
            <TextInput label={`Subject ${at + 1}`} value={term.value} list={`${id}-${term.filter === "category" ? "categories" : "tags"}`} disabled={disabled}
              onChange={event => setTerms(index, group.terms.map((item, n) => n === at ? editedTerm(item, { ...item, value: event.target.value }) : item))}
              onBlur={() => { if (term.value.trim() !== term.value) setTerms(index, group.terms.map((item, n) => n === at ? editedTerm(item, { ...item, value: item.value.trim() }) : item)); }} />
            <Select label={`Move ${term.value || "subject"} to group`} value={group.id} disabled={disabled} onChange={event => {
              const targetId = event.target.value;
              setActiveGroup(targetId); focusAfter(`[data-posts-subject="${termId(term)}"] input`);
              change(config.groups.map((item, n) => {
                if (n === index) { const { cover, ...rest } = item; return { ...rest, terms: item.terms.filter((_, position) => position !== at), ...(cover && postsBrowseTermKey(cover) !== postsBrowseTermKey(term) ? { cover } : {}) }; }
                return item.id === targetId ? { ...item, terms: [...item.terms, term] } : item;
              })); setMessage(`${term.value} moved to ${config.groups.find(item => item.id === targetId)?.label}.${group.cover && postsBrowseTermKey(group.cover) === postsBrowseTermKey(term) ? " The source group will use its first available image." : ""}`);
            }}>{config.groups.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</Select>
            <div className="posts-browse-editor__actions">
              <ActionControl action="move-up" accessibleName={`Move subject up, ${term.value || at + 1}`} disabled={disabled || at === 0} onClick={() => moveTerm(index, at, -1)} />
              <ActionControl action="move-down" accessibleName={`Move subject down, ${term.value || at + 1}`} disabled={disabled || at === group.terms.length - 1} onClick={() => moveTerm(index, at, 1)} />
              <ActionControl action="remove-item" accessibleName={`Remove from group, ${term.value || at + 1}`} disabled={disabled} onClick={() => { const remaining = group.terms.filter((_, position) => position !== at); const neighbor = remaining[at] ?? remaining[at - 1]; focusAfter(neighbor ? `[data-posts-subject="${termId(neighbor)}"] input` : `[data-add-subject="${group.id}"]`); setTerms(index, remaining); }} />
            </div>
          </li>)}</ol>
          <ActionControl action="add-item" label="Add subject" accessibleName={`Add subject to ${group.label}`} data-add-subject={group.id} disabled={disabled || group.terms.length >= 300} onClick={() => { const term: PostsBrowseTerm = { filter: "tag", value: "" }; focusAfter(`[data-posts-subject="${termId(term)}"] input`); setTerms(index, [...group.terms, term]); }} />
          </>}
        </details>
      </li>)}
    </ol>
    <ActionControl action="add-item" label="Add browse group" accessibleName="Add browse group" data-add-browse-group disabled={disabled || config.groups.length >= 8} onClick={() => {
      let number = 1; while (config.groups.some(group => group.id === `group-${number}`)) number++;
      setActiveGroup(`group-${number}`); focusAfter(`[data-posts-group="group-${number}"] input`);
      change([...config.groups, { id: `group-${number}`, label: "New group", icon: "pin", terms: [] }]);
      setMessage("Group added. Open New group to choose its name and subjects.");
    }} />
    </>}
  </details>;
}
