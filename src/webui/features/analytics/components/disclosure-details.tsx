import {ANALYTICS_DISCLOSURE_SECTIONS} from '../constants'

export function DisclosureDetails() {
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
      {ANALYTICS_DISCLOSURE_SECTIONS.map((section) => {
        const Icon = section.icon
        return (
          <div className="flex flex-col gap-2" key={section.label}>
            <Icon className="size-4 text-muted-foreground" strokeWidth={1.75} />
            <div className="flex flex-col gap-1">
              <span className="text-foreground text-[0.6875rem] font-semibold tracking-wider">
                {section.label}
              </span>
              <p className="text-muted-foreground text-[0.8125rem] leading-relaxed">{section.body}</p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
