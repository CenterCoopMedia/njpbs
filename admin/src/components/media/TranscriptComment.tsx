import type { CommentThread } from "../../lib/media-comment-threads";
import { commentTimeLabel } from "../../lib/media-comment-time";
import type { MediaComment } from "../../lib/media-feedback";
import { Button } from "../ui/Primitives";

/** Read-only thread preview. The existing Comments pane owns replies and changes. */
export function TranscriptComment({ thread, onOpen, incomplete }: { thread: CommentThread; onOpen?: (comment: MediaComment) => void; incomplete?: boolean }) {
  const { comment, replies } = thread;
  return <li className="transcript-comment">
    <details>
      <summary>
        <span>{comment.time ? commentTimeLabel(comment.time) : null} · {comment.authorName}</span>
        <span className="transcript-comment-preview">{comment.text}</span>
      </summary>
      <div className="transcript-comment-body">
        <p>{comment.text}</p>
        {comment.resolvedAt ? <p>Resolved</p> : null}
        {replies.length ? <ol aria-label={`Replies to ${comment.authorName}`}>
          {replies.map(reply => <li key={reply.id}><strong>{reply.authorName}</strong><p>{reply.text}</p></li>)}
        </ol> : null}
        {incomplete && comment.hasReplies ? <p>More replies may be available. Use Load more comments below.</p> : null}
        {onOpen ? <Button variant="ghost" onClick={() => onOpen(comment)}>Open in Comments</Button> : null}
      </div>
    </details>
  </li>;
}
