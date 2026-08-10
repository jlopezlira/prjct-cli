/**
 * Uninstall Command
 *
 * Complete system removal of prjct-cli.
 * Handles cleanup of all prjct files, configurations, and installations.
 *
 */

import chalk from 'chalk'
import pathManager from '../infrastructure/path-manager'
import type { CommandResult, UninstallOptions } from '../types/commands'
import { PrjctCommandsBase } from './base'
import { createBackup, performUninstall, promptConfirmation } from './uninstall/actions'
import { detectInstallation, formatSize, gatherUninstallItems } from './uninstall/inventory'

export async function uninstall(
  options: UninstallOptions = {},
  _projectPath: string = process.cwd()
): Promise<CommandResult> {
  const items = await gatherUninstallItems()
  const installation = detectInstallation()
  const existingItems = items.filter((i) => i.exists)

  if (existingItems.length === 0 && !installation.homebrew && !installation.npm) {
    console.log(chalk.yellow('\nNo prjct installation found.'))
    return { success: true, message: 'Nothing to uninstall' }
  }

  const totalSize = existingItems.reduce((sum, item) => sum + (item.size || 0), 0)

  // Display warning and items
  console.log('')
  console.log(chalk.red.bold('  WARNING: This action is DANGEROUS and IRREVERSIBLE'))
  console.log('')
  console.log(chalk.white('The following will be permanently deleted:'))
  console.log('')

  for (const item of existingItems) {
    const displayPath = pathManager.getDisplayPath(item.path)
    const info =
      item.type === 'section'
        ? chalk.dim('(section only)')
        : item.size
          ? chalk.dim(`(${formatSize(item.size)})`)
          : ''

    console.log(`  ${chalk.cyan(displayPath.padEnd(35))} ${info}`)
    console.log(`  ${chalk.dim(item.description)}`)
    console.log('')
  }

  if (installation.homebrew) {
    console.log(`  ${chalk.cyan('Homebrew'.padEnd(35))} ${chalk.dim('prjct-cli formula')}`)
    console.log('')
  }

  if (installation.npm) {
    console.log(`  ${chalk.cyan('npm global'.padEnd(35))} ${chalk.dim('prjct-cli package')}`)
    console.log('')
  }

  if (totalSize > 0) {
    console.log(chalk.dim(`  Total size: ${formatSize(totalSize)}`))
    console.log('')
  }

  if (options.dryRun) {
    console.log(chalk.yellow('Dry run - no changes made'))
    return {
      success: true,
      message: 'Dry run complete',
      itemsFound: existingItems.length,
    }
  }

  if (options.backup) {
    console.log(chalk.blue('Creating backup...'))
    const backupPath = await createBackup()

    if (backupPath) {
      console.log(chalk.green(`Backup created: ${pathManager.getDisplayPath(backupPath)}`))
      console.log('')
    } else {
      console.log(chalk.yellow('Failed to create backup, continuing...'))
    }
  }

  if (!options.force) {
    console.log(chalk.yellow('Type "uninstall" to confirm:'))
    const confirmed = await promptConfirmation('> ')

    if (!confirmed) {
      console.log(chalk.yellow('\nUninstall cancelled.'))
      return { success: false, message: 'Uninstall cancelled by user' }
    }
  }

  console.log('')
  console.log(chalk.blue('Removing prjct...'))

  const { deleted, errors } = await performUninstall(items, installation, options)

  console.log('')

  if (deleted.length > 0) {
    console.log(chalk.green(`Removed ${deleted.length} items`))
  }

  if (errors.length > 0) {
    console.log(chalk.yellow(`\n${errors.length} errors:`))
    for (const error of errors) {
      console.log(chalk.red(`  - ${error}`))
    }
  }

  console.log('')
  console.log(chalk.green('prjct has been uninstalled.'))
  console.log(chalk.dim('Thanks for using prjct! We hope to see you again.'))
  console.log('')

  return {
    success: errors.length === 0,
    message: `Removed ${deleted.length} items`,
    deleted,
    errors: errors.length > 0 ? errors : undefined,
  }
}

export class UninstallCommands extends PrjctCommandsBase {
  async uninstall(
    options: UninstallOptions = {},
    projectPath: string = process.cwd()
  ): Promise<CommandResult> {
    return uninstall(options, projectPath)
  }
}
