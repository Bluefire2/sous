import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLocale, useT } from '../i18n';
import { unitLabel } from '../i18n/unitLabel';
import { chatStore, useChatMessages } from '../lib/chatStore';
import { MemoryBlobImage, StoredPhotoImage } from './BlobImage';
import { photoStore } from '../lib/photoStore';
import { recipeStore } from '../lib/recipeStore';
import { MAX_CHAT_PHOTOS, streamChatReply, type CookingState } from '../lib/chatApi';
import { transcribeAudio } from '../lib/sttApi';
import {
  canRecord,
  startRecording,
  stripTranscript,
  type VoiceSession,
} from '../lib/voiceRecorder';
import {
  encodeImageForChat,
  encodeImageForStorage,
  type EncodedImage,
} from '../lib/image';
import { CameraIcon } from '../lib/icons';
import DialogShell from './DialogShell';
import { formatQuantity } from '../lib/quantity';
import { normalizeRecipeDraft } from '../lib/recipeShape';
import type { ChatMessage, Ingredient, Recipe, RecipeDraft } from '../lib/types';
import {
  addBtnDanger,
  ghostBtn,
  inputFocus,
  primaryBtn,
  secondaryBtn,
} from '../lib/uiClasses';

function ingredientLine(
  ing: Ingredient,
  locale: ReturnType<typeof useLocale>,
  labelUnit: (token: string) => string,
): string {
  const parts = [
    ing.quantity !== undefined ? formatQuantity(ing.quantity, locale) : null,
    ing.unit ? labelUnit(ing.unit) : null,
    ing.item,
  ].filter(Boolean);
  const base = parts.join(' ');
  return ing.note ? `${base} (${ing.note})` : base;
}

function recipeLines(
  r: Recipe | RecipeDraft,
  locale: ReturnType<typeof useLocale>,
  labelUnit: (token: string) => string,
): {
  ingredients: string[];
  steps: string[];
} {
  return {
    ingredients: r.ingredientSections.flatMap((s) =>
      s.items.map((item) => ingredientLine(item, locale, labelUnit)),
    ),
    steps: r.steps.map((s) => s.text),
  };
}

function ProposalCard({
  recipe,
  proposal,
  onNavigateAway,
  allowApply,
}: {
  recipe: Recipe;
  proposal: RecipeDraft;
  onNavigateAway: () => void;
  allowApply: boolean;
}) {
  const navigate = useNavigate();
  const t = useT();
  const locale = useLocale();
  const [applied, setApplied] = useState<'chat.appliedToRecipe' | 'chat.savedAsNew' | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const apply = async () => {
    setSaveError(null);
    try {
      await recipeStore.applyDraft(recipe.id, proposal);
      setApplied('chat.appliedToRecipe');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('error.recipeSave'));
    }
  };

  const saveAsVariant = async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const created = await recipeStore.createFromAsk(recipe, proposal);
      setApplied('chat.savedAsNew');
      onNavigateAway();
      navigate(`/recipe/${created.id}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('error.recipeSave'));
      setSaving(false);
    }
  };

  // The diff is against a recipe that no longer exists in that form.
  if (applied) {
    return (
      <div className="mt-2 rounded-xl border border-line bg-surface p-3">
        <p className="text-sm font-medium text-success">{t(applied)}</p>
      </div>
    );
  }

  const labelUnit = (token: string) => unitLabel(token, t);
  const before = recipeLines(recipe, locale, labelUnit);
  const after = recipeLines(proposal, locale, labelUnit);
  const removedIngredients = before.ingredients.filter(
    (l) => !after.ingredients.includes(l),
  );
  const addedIngredients = after.ingredients.filter(
    (l) => !before.ingredients.includes(l),
  );
  const removedSteps = before.steps.filter((l) => !after.steps.includes(l));
  const addedSteps = after.steps.filter((l) => !before.steps.includes(l));

  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-3">
      <p className="text-sm font-semibold">
        {proposal.title !== recipe.title
          ? t('chat.proposedChangeTitled', { title: proposal.title })
          : t('chat.proposedChange')}
      </p>
      {proposal.servings !== recipe.servings && (
        <p className="mt-1 text-sm text-ink-muted">
          {t('chat.serves', { from: recipe.servings, to: proposal.servings })}
        </p>
      )}
      <div className="mt-1.5 flex flex-col gap-0.5 text-sm">
        {removedIngredients.map((l) => (
          <p key={`ri-${l}`} className="text-danger line-through">{l}</p>
        ))}
        {addedIngredients.map((l) => (
          <p key={`ai-${l}`} className="text-success">+ {l}</p>
        ))}
        {removedSteps.map((l) => (
          <p key={`rs-${l}`} className="text-danger line-through">{l}</p>
        ))}
        {addedSteps.map((l) => (
          <p key={`as-${l}`} className="text-success">+ {l}</p>
        ))}
        {removedIngredients.length + addedIngredients.length + removedSteps.length + addedSteps.length === 0 && (
          <p className="text-ink-muted">{t('chat.metadataOnly')}</p>
        )}
      </div>
      <div className="mt-2.5 flex gap-2">
        {allowApply && (
          <button
            type="button"
            onClick={() => void apply()}
            disabled={saving}
            className={`${primaryBtn} flex-1 py-2 text-sm disabled:opacity-40`}
          >
            {t('chat.apply')}
          </button>
        )}
        <button
          type="button"
          onClick={() => void saveAsVariant()}
          disabled={saving}
          className={`${secondaryBtn} flex-1 py-2 text-sm disabled:opacity-40`}
        >
          {saving
            ? t('common.saving')
            : allowApply
              ? t('chat.saveAsVariant')
              : t('chat.saveAsNewRecipe')}
        </button>
      </div>
      {saveError && <p className="mt-2 text-sm text-danger">{saveError}</p>}
    </div>
  );
}

function PhotoThumb({ photoId }: { photoId: string }) {
  const t = useT();
  return (
    <div className="h-20 w-20 overflow-hidden rounded-lg bg-surface-muted">
      <StoredPhotoImage
        photoId={photoId}
        alt={t('chat.attachedPhoto')}
        className="h-full w-full object-cover"
      />
    </div>
  );
}

function PendingPhotoThumb({ blob }: { blob: Blob }) {
  const t = useT();
  return (
    <div className="h-20 w-20 overflow-hidden rounded-lg bg-surface-muted">
      <MemoryBlobImage
        blob={blob}
        alt={t('chat.attachedPhoto')}
        className="h-full w-full object-cover"
      />
    </div>
  );
}

function MessageBubble({
  message,
  recipe,
  onNavigateAway,
  allowApply,
}: {
  message: ChatMessage;
  recipe: Recipe;
  onNavigateAway: () => void;
  allowApply: boolean;
}) {
  const isUser = message.role === 'user';
  // Rows persisted before normalization may still exist; re-check at
  // render so a malformed proposal degrades to the plain text bubble instead
  // of throwing inside recipeLines on every render.
  const proposal = message.proposedRecipe
    ? normalizeRecipeDraft(message.proposedRecipe)
    : undefined;
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2 whitespace-pre-wrap ${
          isUser ? 'bg-accent-soft' : 'bg-surface-muted'
        }`}
      >
        {message.photoIds && message.photoIds.length > 0 && (
          <div className="mb-1.5 flex gap-1.5">
            {message.photoIds.map((pid) => (
              <PhotoThumb key={pid} photoId={pid} />
            ))}
          </div>
        )}
        {message.content}
        {proposal && (
          <ProposalCard
            recipe={recipe}
            proposal={proposal}
            onNavigateAway={onNavigateAway}
            allowApply={allowApply}
          />
        )}
      </div>
    </div>
  );
}

export default function ChatPanel({
  recipe,
  cookingState,
  onClose,
  readOnly = false,
  allowApply = !readOnly,
}: {
  recipe: Recipe;
  cookingState: CookingState;
  onClose: () => void;
  /** A shared recipe: no photo attachments, and no Apply unless `allowApply`. */
  readOnly?: boolean;
  /** An editor of a shared recipe may Apply; the store keeps its photos as they are. */
  allowApply?: boolean;
}) {
  const messages = useChatMessages(recipe.id);
  const t = useT();
  const [draft, setDraft] = useState('');
  const [pendingPhotos, setPendingPhotos] = useState<
    { key: string; blob: Blob }[]
  >([]);
  const pendingRef = useRef(pendingPhotos);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const sessionRef = useRef<VoiceSession | null>(null);
  const sttAbort = useRef<AbortController | null>(null);
  const finishingRef = useRef(false);
  const mountedRef = useRef(true);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const micAvailable = canRecord();

  const busy = streamingText !== null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages?.length, streamingText]);

  // The sheet unmounts on close and on navigation; a reply nobody can read is
  // still billed until the request is cancelled. Drop the mic stream too.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inFlight.current?.abort();
      sttAbort.current?.abort();
      sessionRef.current?.abort();
      sessionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!busy) {
      return;
    }
    sessionRef.current?.abort();
    sessionRef.current = null;
    sttAbort.current?.abort();
    finishingRef.current = false;
    setListening(false);
    setTranscribing(false);
  }, [busy]);

  const setPending = (photos: { key: string; blob: Blob }[]) => {
    pendingRef.current = photos;
    setPendingPhotos(photos);
  };

  const attachPhoto = async (file: File) => {
    // The server refuses a message with more photos than this (400).
    if (pendingRef.current.length >= MAX_CHAT_PHOTOS) return;
    try {
      // The originals are several megabytes; downscale before attach.
      // and exportLibrary re-encodes every stored blob as base64 — same intent
      // as RecipeForm.
      const stored = await encodeImageForStorage(file);
      setError(null);
      setPending([
        ...pendingRef.current,
        { key: crypto.randomUUID(), blob: stored },
      ]);
    } catch {
      setError(t('error.photoUnreadable'));
    }
  };

  const discardPending = () => {
    setPending([]);
  };

  const removePending = (key: string) => {
    setPending(pendingRef.current.filter((p) => p.key !== key));
  };

  // Two-tap clear: the first tap arms the button, the second commits. Awaited
  // (not voided) so a failure surfaces and the armed state only resets once
  // the thread is actually gone.
  const onClearClick = async () => {
    if (clearing) return;
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setClearing(true);
    try {
      await chatStore.clearForRecipe(recipe.id);
      setConfirmClear(false);
    } catch {
      setError(t('chat.threadClearFailed'));
    } finally {
      setClearing(false);
    }
  };

  const applyTranscript = async (blob: Blob | null) => {
    if (finishingRef.current) {
      return;
    }
    finishingRef.current = true;
    sessionRef.current = null;
    setListening(false);
    if (!blob || blob.size === 0) {
      finishingRef.current = false;
      return;
    }
    const controller = new AbortController();
    sttAbort.current = controller;
    setTranscribing(true);
    try {
      const text = await transcribeAudio({
        blob,
        title: recipe.title,
        signal: controller.signal,
      });
      const next = stripTranscript(text);
      if (next !== '') {
        setDraft((current) => {
          const base = current.trimEnd();
          return base === '' ? next : `${base} ${next}`;
        });
      }
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) {
        return;
      }
      setError(
        err instanceof Error ? err.message : t('error.dictationFailed'),
      );
    } finally {
      if (sttAbort.current === controller) {
        sttAbort.current = null;
      }
      if (mountedRef.current) {
        setTranscribing(false);
      }
      finishingRef.current = false;
    }
  };

  const onMicClick = async () => {
    if (busy || transcribing) {
      return;
    }
    if (listening) {
      const session = sessionRef.current;
      sessionRef.current = null;
      setListening(false);
      const blob = session ? await session.stop() : null;
      await applyTranscript(blob);
      return;
    }
    setError(null);
    finishingRef.current = false;
    setListening(true);
    try {
      const session = await startRecording((blob) => {
        void applyTranscript(blob);
      });
      if (!mountedRef.current) {
        session.abort();
        return;
      }
      sessionRef.current = session;
    } catch (err) {
      setListening(false);
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setError(
          t('chat.micBlocked'),
        );
      } else if (name === 'NotFoundError') {
        setError(t('chat.noMic'));
      } else {
        setError(t('error.dictationFailed'));
      }
    }
  };

  const send = async () => {
    const content = draft.trim();
    if ((content === '' && pendingPhotos.length === 0) || busy || transcribing) return;

    setError(null);
    setStreamingText('');
    const photos = pendingPhotos;

    // Encode before writing the user message, so a photo we cannot read leaves
    // the thread untouched instead of orphaning a question.
    let images: EncodedImage[];
    try {
      images = await Promise.all(
        photos.map((p) => encodeImageForChat(p.blob)),
      );
    } catch {
      setStreamingText(null);
      setError(t('error.photoUnreadable'));
      discardPending();
      return;
    }

    const storedIds: string[] = [];
    try {
      for (const photo of photos) {
        storedIds.push(await photoStore.add(photo.blob));
      }
    } catch {
      await Promise.all(storedIds.map((id) => photoStore.remove(id)));
      setStreamingText(null);
      setError(t('chat.photoSaveFailed'));
      return;
    }

    const history = messages ?? [];
    try {
      await chatStore.append({
        recipeId: recipe.id,
        role: 'user',
        content,
        photoIds: storedIds,
      });
    } catch {
      await Promise.all(storedIds.map((id) => photoStore.remove(id)));
      setStreamingText(null);
      setError(t('chat.messageSaveFailed'));
      return;
    }

    setPending([]);
    setDraft('');

    const controller = new AbortController();
    inFlight.current = controller;
    let streamed = '';
    try {
      const reply = await streamChatReply({
        recipe,
        cookingState,
        messages: [
          // Only the newest message carries its photos, because re-encoding
          // every earlier photo on every turn would multiply the token cost of
          // a long thread — so the assistant cannot compare against a photo
          // from an earlier message, even though the thread still displays it.
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user' as const, content, images },
        ],
        onDelta: (textSoFar) => {
          streamed = textSoFar;
          setStreamingText(textSoFar);
        },
        signal: controller.signal,
      });
      const assistantContent =
        reply.text.trim() ||
        (reply.proposedRecipe ? t('chat.proposalIntro') : '');
      await chatStore.append({
        recipeId: recipe.id,
        role: 'assistant',
        content: reply.truncated
          ? `${assistantContent}\n\n${t('chat.replyCutOff')}`
          : assistantContent,
        proposedRecipe: reply.proposedRecipe,
      });
    } catch (e) {
      // Half an answer beats a question left hanging in the thread. An abort is
      // the user's own doing, so it needs no bubble of its own and no error.
      const partial = streamed.trim();
      if (controller.signal.aborted) {
        if (partial !== '') {
          await chatStore.append({
            recipeId: recipe.id,
            role: 'assistant',
            content: partial,
          });
        }
      } else {
        const message =
          e instanceof Error ? e.message : t('common.somethingWentWrong');
        await chatStore.append({
          recipeId: recipe.id,
          role: 'assistant',
          content: partial ? `${partial}\n\n⚠️ ${message}` : `⚠️ ${message}`,
        });
        setError(message);
      }
    } finally {
      inFlight.current = null;
      setStreamingText(null);
    }
  };

  return (
    <DialogShell
      onClose={onClose}
      backdropLabel={t('chat.closeChat')}
      overlayClassName="fixed inset-0 z-20 flex flex-col justify-end"
      panelClassName="flex h-[75dvh] flex-col rounded-t-3xl bg-surface shadow-2xl md:mx-auto md:w-full md:max-w-xl"
    >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-semibold">{t('chat.assistant')}</h2>
          <div className="flex items-center gap-1">
            {(messages ?? []).length > 0 && (
              <button
                type="button"
                onClick={() => void onClearClick()}
                // A stream that resolves after a clear would append into an
                // empty thread, so the control is inert while busy.
                disabled={busy}
                className={confirmClear ? addBtnDanger : ghostBtn}
              >
                {confirmClear ? t('chat.clearAll') : t('chat.clear')}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className={ghostBtn}
            >
              {t('common.close')}
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
          <div className="flex flex-col gap-2.5">
            {(messages ?? []).map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                recipe={recipe}
                onNavigateAway={onClose}
                allowApply={allowApply}
              />
            ))}
            {streamingText !== null && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl bg-surface-muted px-3.5 py-2 whitespace-pre-wrap">
                  {streamingText === '' ? '…' : streamingText}
                </div>
              </div>
            )}
            {error && (
              <p className="rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            {(messages ?? []).length === 0 && streamingText === null && (
              <p className="py-8 text-center text-sm text-ink-subtle">
                {t('chat.emptyHint')}
              </p>
            )}
          </div>
        </div>

        {pendingPhotos.length > 0 && (
          <div className="flex gap-2 px-4 pb-1">
            {pendingPhotos.map((p) => (
              <div key={p.key} className="relative">
                <PendingPhotoThumb blob={p.blob} />
                <button
                  type="button"
                  aria-label={t('common.removePhoto')}
                  onClick={() => removePending(p.key)}
                  className="absolute -top-1.5 -right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-ink text-xs text-page hover:opacity-80 active:opacity-80"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 border-t border-line px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void attachPhoto(file);
              e.target.value = '';
            }}
          />
          {!readOnly && (
          <button
            type="button"
            aria-label={t('chat.attachPhoto')}
            disabled={pendingPhotos.length >= MAX_CHAT_PHOTOS}
            onClick={() => fileInputRef.current?.click()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-muted hover:bg-line-strong active:bg-line-strong disabled:opacity-40"
          >
            <CameraIcon className="block h-5 w-5" />
          </button>
          )}
          {micAvailable && (
            <button
              type="button"
              aria-label={
                transcribing
                  ? t('chat.transcribing')
                  : listening
                    ? t('chat.stopDictation')
                    : t('chat.dictate')
              }
              aria-pressed={listening}
              aria-busy={transcribing}
              disabled={busy || transcribing}
              onClick={() => void onMicClick()}
              className={
                listening || transcribing
                  ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white hover:bg-amber-600 active:bg-amber-600 disabled:opacity-40'
                  : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-ink hover:bg-line-strong active:bg-line-strong disabled:opacity-40'
              }
            >
              <svg
                viewBox="0 0 24 24"
                className={`h-5 w-5 ${transcribing ? 'animate-pulse' : ''}`}
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
              </svg>
            </button>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={t('chat.placeholder')}
            className={`max-h-32 flex-1 resize-none rounded-2xl border border-line bg-page px-3.5 py-2 ${inputFocus}`}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || transcribing}
            className={`${primaryBtn} h-10 px-4`}
          >
            {t('chat.send')}
          </button>
        </div>
    </DialogShell>
  );
}
