import {createBrowserRouter} from 'react-router-dom'

import {ProjectGuard} from './features/project/components/project-guard'
import {MainLayout} from './layouts/main-layout'
import {AnalyticsPage} from './pages/analytics-page'
import {ChangesPage} from './pages/changes-page'
import {ConnectorsSection} from './pages/configuration/connectors'
import {GeneralSection} from './pages/configuration/general'
import {ConfigurationLayout} from './pages/configuration/layout'
import {VersionControlSection} from './pages/configuration/version-control'
import {ContextsPage} from './pages/contexts-page'
import {HomePage} from './pages/home-page'
import {NotFoundPage} from './pages/not-found-page'
import {ProjectSelectorPage} from './pages/project-selector-page'
import {TasksPage} from './pages/tasks-page'

export const router = createBrowserRouter([
  {
    element: <ProjectSelectorPage />,
    path: '/projects',
  },
  {
    children: [
      {
        children: [
          {
            element: <HomePage />,
            index: true,
          },
          {
            element: <ChangesPage />,
            path: 'changes',
          },
          {
            children: [
              {element: <GeneralSection />, index: true},
              {element: <ConnectorsSection />, path: 'connectors'},
              {element: <VersionControlSection />, path: 'version-control'},
            ],
            element: <ConfigurationLayout />,
            path: 'configuration',
          },
          {
            element: <AnalyticsPage />,
            path: 'analytics',
          },
          {
            element: <ContextsPage />,
            path: 'contexts',
          },
          {
            element: <TasksPage />,
            path: 'tasks',
          },
          {
            element: <NotFoundPage />,
            path: '*',
          },
        ],
        element: <MainLayout />,
      },
    ],
    element: <ProjectGuard />,
    path: '/',
  },
  {
    element: <NotFoundPage />,
    path: '*',
  },
])
