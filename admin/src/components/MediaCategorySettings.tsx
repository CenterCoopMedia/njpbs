import { useSettingsDirty } from "./SettingsWorkspace";
import { useEffect, useState, type FormEvent } from "react";
import type {
  ListMediaCategoriesResponse,
  MediaCategoryDefinition,
  MutateMediaCategoryRequest,
  MutateMediaCategoryResponse,
} from "../lib/functions";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Panel,
  StatusBadge,
  Textarea,
  TextInput,
} from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";

export interface MediaCategorySettingsTransport {
  load: () => Promise<ListMediaCategoriesResponse>;
  mutate: (
    request: MutateMediaCategoryRequest,
    etag?: string,
  ) => Promise<MutateMediaCategoryResponse>;
}

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; categories: MediaCategoryDefinition[] };

function sortCategories(categories: MediaCategoryDefinition[]) {
  return [...categories].sort(
    (left, right) =>
      left.order - right.order ||
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" }) ||
      left.id.localeCompare(right.id),
  );
}

function replaceCategory(
  categories: MediaCategoryDefinition[],
  category: MediaCategoryDefinition,
) {
  return sortCategories([
    ...categories.filter((candidate) => candidate.id !== category.id),
    category,
  ]);
}

export function MediaCategorySettings({
  load,
  mutate,
}: MediaCategorySettingsTransport) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [order, setOrder] = useState("0");
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newOrder, setNewOrder] = useState("100");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editing = state.status === "ready" ? state.categories.find(category => category.id === editingId) : undefined;
  useSettingsDirty(Boolean((creating && (newId || newLabel || newDescription || newOrder !== "100")) ||
    (editing && (label !== editing.label || description !== (editing.description ?? "") || order !== String(editing.order)))), saving);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setError(null);
    load()
      .then((response) => {
        if (!cancelled) {
          setState({ status: "ready", categories: sortCategories(response.categories) });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, load]);

  function beginEdit(category: MediaCategoryDefinition) {
    setEditingId(category.id);
    setConfirmingArchive(null);
    setLabel(category.label);
    setDescription(category.description);
    setOrder(String(category.order));
    setError(null);
    setNotice(null);
  }

  async function runMutation(
    request: MutateMediaCategoryRequest,
    etag?: string,
  ): Promise<boolean> {
    if (saving || state.status !== "ready") return false;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await mutate(request, etag);
      setState({
        status: "ready",
        categories: replaceCategory(state.categories, response.category),
      });
      setEditingId(null);
      setConfirmingArchive(null);
      setCreating(false);
      setNotice(
        response.changed
          ? "Media category saved."
          : "No category changes were needed.",
      );
      return true;
    } catch (mutationError) {
      const status =
        typeof mutationError === "object" && mutationError !== null
          ? (mutationError as { status?: unknown }).status
          : null;
      setError(
        status === 412
          ? "This category changed. Reload the registry before saving."
          : mutationError instanceof Error
            ? mutationError.message
            : "The media category could not be saved.",
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(
    event: FormEvent<HTMLFormElement>,
    category: MediaCategoryDefinition,
  ) {
    event.preventDefault();
    const nextOrder = Number(order);
    if (!Number.isSafeInteger(nextOrder) || nextOrder < 0) {
      setError("Order must be a whole number of zero or greater.");
      return;
    }
    await runMutation(
      {
        action: "update",
        id: category.id,
        changes: category.reserved
          ? { order: nextOrder }
          : {
              label: label.trim(),
              description: description.trim(),
              order: nextOrder,
            },
      },
      category.etag,
    );
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextOrder = Number(newOrder);
    if (!Number.isSafeInteger(nextOrder) || nextOrder < 0) {
      setError("Order must be a whole number of zero or greater.");
      return;
    }
    const created = await runMutation({
      action: "create",
      category: {
        id: newId.trim(),
        label: newLabel.trim(),
        description: newDescription.trim(),
        order: nextOrder,
      },
    });
    if (!created) return;
    setNewId("");
    setNewLabel("");
    setNewDescription("");
    setNewOrder("100");
  }

  if (state.status === "loading") {
    return (
      <LoadingIndicator
        label="Loading media categories"
        stages={["Asking the CMS for the managed category registry"]}
      />
    );
  }
  if (state.status === "error") {
    return (
      <InlineMessage tone="error" title="Media categories could not be loaded">
        <p>Try the request again.</p>
        <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
      </InlineMessage>
    );
  }

  return (
    <Panel className="admin-settings-panel media-category-settings" aria-labelledby="media-category-settings-heading">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Media library</span>
          <h2 id="media-category-settings-heading">Managed categories</h2>
          <p>
            Category IDs stay fixed because they scope permissions and storage. Labels,
            descriptions and order can change without moving media files.
          </p>
        </div>
        {!creating ? (
          <Button variant="primary" onClick={() => setCreating(true)}>
            Add category
          </Button>
        ) : null}
      </div>

      {notice ? <p role="status">{notice}</p> : null}
      {error ? (
        <InlineMessage tone="error" title="Media category was not saved">
          {error}
        </InlineMessage>
      ) : null}

      {creating ? (
        <form className="media-category-form" onSubmit={create}>
          <label>
            Category ID
            <TextInput
              value={newId}
              maxLength={60}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              required
              onChange={(event) => setNewId(event.target.value)}
            />
          </label>
          <label>
            Label
            <TextInput
              value={newLabel}
              maxLength={80}
              required
              onChange={(event) => setNewLabel(event.target.value)}
            />
          </label>
          <label>
            Order
            <TextInput
              type="number"
              min={0}
              max={100_000}
              value={newOrder}
              required
              onChange={(event) => setNewOrder(event.target.value)}
            />
          </label>
          <label className="media-category-description-field">
            Description
            <Textarea
              value={newDescription}
              maxLength={300}
              rows={2}
              onChange={(event) => setNewDescription(event.target.value)}
            />
          </label>
          <div className="media-form-actions">
            <AsyncActionButton
              label="Create category"
              pending={saving}
              pendingLabel="Creating…"
              type="submit"
              variant="primary"
            />
            <Button type="button" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      <ul className="media-category-list" aria-label="Media categories">
        {state.categories.map((category) => (
          <li key={category.id}>
            {editingId === category.id ? (
              <form
                className="media-category-form"
                onSubmit={(event) => saveEdit(event, category)}
              >
                <div>
                  <strong>{category.id}</strong>
                  {category.reserved ? <StatusBadge tone="neutral">Reserved</StatusBadge> : null}
                </div>
                <label>
                  Label
                  <TextInput
                    value={label}
                    maxLength={80}
                    required
                    disabled={category.reserved || saving}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </label>
                <label>
                  Order
                  <TextInput
                    type="number"
                    min={0}
                    max={100_000}
                    value={order}
                    required
                    disabled={saving}
                    onChange={(event) => setOrder(event.target.value)}
                  />
                </label>
                <label className="media-category-description-field">
                  Description
                  <Textarea
                    value={description}
                    maxLength={300}
                    rows={2}
                    disabled={category.reserved || saving}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </label>
                <div className="media-form-actions">
                  <AsyncActionButton
                    label="Save category"
                    pending={saving}
                    pendingLabel="Saving…"
                    type="submit"
                    variant="primary"
                  />
                  <Button type="button" onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="media-category-summary">
                <div>
                  <div className="media-category-title">
                    <strong>{category.label}</strong>
                    <StatusBadge tone={category.active ? "success" : "neutral"}>
                      {category.active ? "Active" : "Archived"}
                    </StatusBadge>
                    {category.reserved ? <StatusBadge tone="neutral">Reserved</StatusBadge> : null}
                  </div>
                  <code>{category.id}</code>
                  <p>{category.description || "No description"}</p>
                  <span>Order {category.order}</span>
                </div>
                <div className="media-category-actions">
                  <Button onClick={() => beginEdit(category)}>Edit</Button>
                  {!category.reserved && category.active ? (
                    confirmingArchive === category.id ? (
                      <>
                        <Button
                          variant="danger"
                          disabled={saving}
                          onClick={() =>
                            void runMutation(
                              { action: "archive", id: category.id },
                              category.etag,
                            )
                          }
                        >
                          Confirm archive
                        </Button>
                        <Button onClick={() => setConfirmingArchive(null)}>Cancel</Button>
                      </>
                    ) : (
                      <Button onClick={() => setConfirmingArchive(category.id)}>
                        Archive
                      </Button>
                    )
                  ) : !category.reserved ? (
                    <Button
                      disabled={saving}
                      onClick={() =>
                        void runMutation(
                          { action: "restore", id: category.id },
                          category.etag,
                        )
                      }
                    >
                      Restore
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
