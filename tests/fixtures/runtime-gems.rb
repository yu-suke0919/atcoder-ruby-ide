require 'json'
require 'bigdecimal'
require 'openssl'
require 'prime'
require 'rexml/document'
require 'pairing_heap'
require 'ac-library-rb/dsu'
require 'bitarray'
require 'faster_prime'
require 'rgl/adjacency'
require 'rgl/topsort'
require 'sorted_containers'
require 'rbtree'
require 'sorted_set'
require 'immutable'
require 'bit_utils'
require 'trie'
require 'numo/narray'
require 'rumale'

puts RUBY_VERSION.split('.')[0, 2].join('.')
%w[prime rexml pairing_heap stream ac-library-rb bitarray faster_prime rgl sorted_containers rbtree sorted_set immutable-ruby bit_utils fast_trie numo-narray rumale lbfgsb].each do |name|
  puts "#{name}:#{Gem.loaded_specs.fetch(name).version}"
end
dsu = AcLibraryRb::DSU.new(4)
dsu.merge(0, 2)
puts dsu.same?(0, 2)
puts FasterPrime.prime?(1_000_000_007)
bits = BitArray.new(8)
bits[3] = 1
puts bits.to_s
graph = RGL::DirectedAdjacencyGraph[0, 1, 1, 2]
puts graph.topsort_iterator.to_a.join(',')
puts SortedContainers::SortedArray.new([3, 1, 2]).to_a.join(',')
puts RBTree[3, 'c', 1, 'a'].first.join(',')
puts SortedSet.new([3, 1, 2]).to_a.join(',')
puts Immutable::SortedSet[3, 1, 2].add(0).to_a.join(',')
puts BitUtils.popcount(0b1011)
trie = Trie.new
trie.add('atcoder')
puts trie.children('at').join(',')
puts Numo::Int64[1, 2, 3].sum
puts Rumale::Preprocessing::MinMaxScaler.new.fit_transform(Numo::DFloat[[1.0], [3.0]]).to_a.flatten.join(',')
puts JSON.generate(value: BigDecimal('1.5').to_s('F'), input: STDIN.read.chomp)
