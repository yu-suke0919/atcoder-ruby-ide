require 'json'
require 'rubygems/installer'

directory = ARGV.fetch(0)
directory = Gem.default_dir if directory.empty?
packages = JSON.parse(ARGV.fetch(1))

# Inspect every verified package before changing the installation directory.
installers = packages.map do |entry|
  installer = Gem::Installer.at(entry.fetch('file'), install_dir: directory,
    ignore_dependencies: true, document: [], wrappers: false)
  spec = installer.spec
  unless spec.name == entry.fetch('name') && spec.version.to_s == entry.fetch('version')
    raise "gem identity が固定情報と一致しません: #{entry.fetch('file')}"
  end
  unless spec.platform == Gem::Platform::RUBY && spec.extensions.empty?
    raise "C拡張・native platformのgemは同梱対象外です: #{spec.full_name}"
  end
  installer
end
installers.each do |installer|
  spec = installer.install
  puts "Installed #{spec.full_name} into #{directory}"
end
