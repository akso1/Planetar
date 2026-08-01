/** Frameless window drag strip — leave space for macOS traffic lights */
export function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      className="h-[38px] flex-shrink-0 select-none"
      style={{ WebkitAppRegion: 'drag' }}
      aria-hidden
    />
  )
}
