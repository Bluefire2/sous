import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { ChatBubbleIcon } from '../lib/icons';

/**
 * The library's way into the assistant: a round amber button beside the add
 * button, amber like the recipe screen's Ask, so the two AI entry points read
 * as one family. An icon, not a word: "Запитати" and "Спросить" would make a
 * pill twice as wide at the bottom of a phone screen. The caller positions it.
 */
export default function AssistantEntryLink() {
  const tr = useT();
  return (
    <Link
      to="/assistant"
      aria-label={tr('assistant.ask')}
      className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-500 text-white shadow-lg hover:bg-amber-600 active:bg-amber-600"
    >
      <ChatBubbleIcon className="block h-6 w-6" />
    </Link>
  );
}
