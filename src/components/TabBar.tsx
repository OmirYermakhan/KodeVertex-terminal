// Левый отступ 80px освобождает место под кнопки окна macOS (titleBarStyle: Overlay).
export default function TabBar() {
  return (
    <div
      data-testid="tabbar"
      data-tauri-drag-region
      style={{
        height: 38,
        flexShrink: 0,
        paddingLeft: 80,
        background: 'var(--panel)',
      }}
    />
  )
}
