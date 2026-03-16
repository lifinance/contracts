export class Spinner {
  private spinnerChars: string[]
  private interval: NodeJS.Timeout | null = null
  private index = 0
  public text: string

  constructor(text: string) {
    this.text = text
    this.spinnerChars = ['|', '/', '-', '\\']
  }

  start(newText?: string) {
    if (newText) this.text = newText
    process.stdout.write(this.text + ' ' + this.spinnerChars[this.index])
    this.interval = setInterval(() => {
      this.index = (this.index + 1) % this.spinnerChars.length
      process.stdout.write(
        '\r' + this.text + ' ' + this.spinnerChars[this.index]
      )
    }, 100)
  }

  succeed(newText?: string) {
    if (this.interval) clearInterval(this.interval)
    process.stdout.write('\r' + (newText || this.text) + ' ✔\n')
  }

  fail(newText?: string) {
    if (this.interval) clearInterval(this.interval)
    process.stdout.write('\r' + (newText || this.text) + ' ✖\n')
  }
}
