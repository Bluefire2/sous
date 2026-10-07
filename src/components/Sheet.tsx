import type { ReactNode } from 'react';
import { useT } from '../i18n';
import DialogShell from './DialogShell';

export default function Sheet({
  onClose,
  children,
  dismissible = true,
}: {
  onClose: () => void;
  children: ReactNode;
  dismissible?: boolean;
}) {
  const t = useT();
  return (
    <DialogShell
      onClose={onClose}
      dismissible={dismissible}
      backdropLabel={t('sheet.dismiss')}
      overlayClassName="fixed inset-0 z-30 flex flex-col justify-end"
      panelClassName="max-h-[90dvh] overflow-y-auto overscroll-contain rounded-t-3xl bg-surface px-4 pt-4 pb-[max(1rem,var(--sheet-safe-bottom,env(safe-area-inset-bottom)))] shadow-2xl md:mx-auto md:w-full md:max-w-xl"
    >
      {children}
    </DialogShell>
  );
}
