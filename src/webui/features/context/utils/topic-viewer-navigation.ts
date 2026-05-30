interface TopicViewerNavigationDeps {
  navigate: (path: string) => void
  onStalePath: (path: string) => void
  pathExists: (path: string) => boolean
}

export function createTopicViewerNavigation({navigate, onStalePath, pathExists}: TopicViewerNavigationDeps) {
  const safeNavigate = (path: string) => {
    if (pathExists(path)) {
      navigate(path)
    } else {
      onStalePath(path)
    }
  }

  return {
    onBreadcrumbClick(segments: string[]) {
      if (segments.length === 0) return
      safeNavigate(segments.join('/'))
    },
    onEntryClick(entry: {path: string}) {
      safeNavigate(entry.path)
    },
    onRelatedClick(path: string) {
      safeNavigate(path.replace(/^@/, ''))
    },
  }
}
