import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportAppError } from '@/shared/lib/errorLog'
import { useRoomStore } from '@/entities/session/model/room.store'

type Props = {
  children: ReactNode
  /** Soft boundary: show inline recovery instead of full-screen */
  soft?: boolean
}

type State = {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const roomId = useRoomStore.getState().activeRoomId
    reportAppError({
      error,
      source: 'react',
      stack: [error.stack, errorInfo.componentStack]
        .filter(Boolean)
        .join('\n\n'),
      context: {
        roomId,
        screen: this.props.soft ? 'soft_boundary' : 'root_boundary',
      },
    })
  }

  private recover = () => {
    this.setState({ hasError: false, error: null })
  }

  public render() {
    if (!this.state.hasError) return this.props.children

    if (this.props.soft) {
      return (
        <div className="m-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-100">
          <div className="font-semibold mb-1">Этот блок интерфейса сбойнул</div>
          <div className="text-amber-100/75 mb-3">
            Ошибка сохранена в Настройки → Ошибки. Можно продолжить работу.
          </div>
          <button
            type="button"
            onClick={this.recover}
            className="rounded-lg bg-white/10 hover:bg-white/15 px-3 py-1.5 text-[12.5px] font-medium"
          >
            Восстановить блок
          </button>
        </div>
      )
    }

    return (
      <div className="h-screen w-screen flex items-center justify-center bg-chatBg px-6">
        <div className="max-w-md w-full rounded-2xl border border-hairline bg-chatSidebar p-6 shadow-panel backdrop-blur-md">
          <h1 className="text-lg font-semibold text-chatText mb-2">
            Что-то пошло не так
          </h1>
          <p className="text-[13.5px] text-white/55 leading-relaxed mb-4">
            Интерфейс упал, но приложение не закрылось. Ошибка записана в{' '}
            <span className="text-white/80">Настройки → Ошибки</span> — оттуда
            её можно отправить по почте.
          </p>
          {this.state.error && (
            <pre className="mb-4 max-h-28 overflow-auto rounded-lg bg-black/30 border border-white/5 p-3 text-[11px] text-red-300/90 whitespace-pre-wrap break-words">
              {this.state.error.message}
            </pre>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.recover}
              className="flex-1 rounded-lg bg-accent/50 hover:bg-accent/70 border border-accent/60 text-chatText text-sm font-medium py-2.5"
            >
              Попробовать снова
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="flex-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-chatText text-sm font-medium py-2.5"
            >
              Перезагрузить
            </button>
          </div>
        </div>
      </div>
    )
  }
}
